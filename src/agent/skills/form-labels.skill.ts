import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { z } from 'zod';
import { AgentSkill } from '../../enums/agent-skill.enum';
import { IssueImpact } from '../../enums/issue-impact.enum';
import type { AgentHarnessService } from '../harness/agent-harness.service';
import type {
  AgentFindingDraft,
  AuditSkill,
  CollectContext,
  Evidence,
} from './audit-skill.interface';

/** Confidence below which a problem verdict is downgraded to human review. */
const MIN_CONFIDENCE = 0.5;

/** Max individual fields included in one page request (token bound). */
const MAX_FIELDS = 25;
/** Longest accessible name / label kept per control. */
const NAME_MAX = 120;
/** Longest describedby (existing instructions) text kept per field. */
const DESC_MAX = 180;
/** Max findings the model may return in one page request. */
const MAX_FINDINGS = 40;

/**
 * Verdicts the model may return. This skill owns a single task — judging the
 * clarity of a control's visible label and instructions. Everything that can be
 * tested deterministically is intentionally absent: a missing/empty label
 * (`label`), a title-only label (`label-title-only`), multiple labels
 * (`form-field-multiple-labels`), missing button/select names, and invalid
 * autocomplete syntax (`autocomplete-valid`) are axe's; and attribute/structure
 * facts (required state, placeholder-as-sole-label, radio/checkbox grouping,
 * missing autocomplete tokens) are deterministic and not judged here.
 */
const FORM_VERDICTS = [
  'appropriate',
  'label_not_descriptive',
  'missing_instructions',
  'insufficient_evidence',
] as const;

type FormVerdict = (typeof FORM_VERDICTS)[number];

/**
 * Maps each verdict to the WCAG success criterion it evaluates. An
 * uninformative label fails 2.4.6 Headings and Labels (AA); a field that needs
 * format/constraint guidance the user is never given fails 3.3.2 Labels or
 * Instructions (A).
 */
const WCAG_FOR_VERDICT: Record<FormVerdict, string | null> = {
  appropriate: null,
  label_not_descriptive: '2.4.6',
  missing_instructions: '3.3.2',
  insufficient_evidence: null,
};

/**
 * Structured page verdict. Every field is required (`suggestedText` is
 * nullable, not optional): OpenAI strict mode rejects a schema whose `required`
 * array omits a property, so optional fields must be modeled as nullable.
 */
export const formLabelsSchema = z.object({
  findings: z
    .array(
      z.object({
        id: z.string(),
        verdict: z.enum(FORM_VERDICTS),
        confidence: z.number().min(0).max(1),
        rationale: z.string().max(400),
        suggestedText: z.string().max(300).nullable(),
      }),
    )
    .max(MAX_FINDINGS),
});

type FormLabelsResult = z.infer<typeof formLabelsSchema>;

/** Returned when the model fails to produce a valid verdict. */
const NO_FINDINGS: FormLabelsResult = { findings: [] };

/** How a control's accessible name was derived. */
type NameSource =
  | 'label'
  | 'wrapping-label'
  | 'aria-label'
  | 'aria-labelledby'
  | 'placeholder'
  | 'title';

/** One labellable form control in the page's inventory. */
export interface FieldDescriptor {
  /**
   * Short stable id (`I1`, `I2`, …) the model echoes back. Models do not
   * reliably reproduce a long CSS path verbatim, so findings are keyed by this
   * token and mapped back to {@link FieldDescriptor.selector} for the client.
   */
  id: string;
  /** Real CSS selector emitted to the client (the finding's only locator). */
  selector: string;
  /** Control type: input `type`, `select`, `textarea`, or ARIA role. */
  controlType: string;
  /** Computed accessible name (may be empty; axe owns truly nameless fields). */
  name: string;
  /** How the accessible name was derived (weakly signals label quality). */
  nameSource: NameSource | null;
  /** The field's placeholder text, when present (may hold an informal hint). */
  placeholder?: string;
  /** Resolved `aria-describedby` text — the instructions already provided. */
  describedby?: string;
  /** Compact constraint hints (pattern/inputmode/min/max/maxlength). */
  constraints?: string;
}

/** Page-level evidence: the labellable form controls. */
export interface FormEvidence extends Evidence {
  pageUrl: string;
  fields: FieldDescriptor[];
}

/**
 * Page-level skill judging the *clarity of a form control's label and
 * instructions* — the one semantic gap axe-core cannot close. axe reports
 * missing/empty labels, title-only labels, multiple labels, and missing
 * select/button names; this skill judges whether a *present* label is
 * descriptive (2.4.6) and whether a field that needs format/constraint guidance
 * actually provides it (3.3.2). Everything testable deterministically —
 * required state, placeholder-as-label, control grouping, autocomplete tokens —
 * is out of scope by design.
 */
@Injectable()
export class FormLabelsSkill implements AuditSkill<FormEvidence> {
  readonly id = AgentSkill.FORM_LABELS;
  readonly granularity = 'page' as const;
  readonly order = 40;

  private readonly logger = new Logger(FormLabelsSkill.name);

  async collect(page: Page, ctx: CollectContext): Promise<FormEvidence[]> {
    // A page-level skill consumes a single unit; nothing to do if the scan
    // budget is exhausted.
    if (ctx.remainingUnits <= 0) {
      return [];
    }

    let fields: FieldDescriptor[];
    try {
      fields = await this.extract(page);
    } catch (error) {
      this.logger.debug(
        `Form extraction failed on ${ctx.pageUrl}: ${String(error)}`,
      );
      return [];
    }

    // No form controls means nothing only a model can judge — skip the request.
    if (fields.length === 0) {
      return [];
    }

    return [{ pageUrl: ctx.pageUrl, fields }];
  }

  async evaluate(
    evidence: FormEvidence,
    harness: AgentHarnessService,
  ): Promise<AgentFindingDraft[]> {
    const { data, usage, model } = await harness.evaluateStructured({
      system: FORM_LABELS_SYSTEM_PROMPT,
      prompt: buildFormPrompt(evidence),
      images: [],
      schema: formLabelsSchema,
      fallback: NO_FINDINGS,
      skill: this.id,
    });

    const problems = data.findings.filter((f) => f.verdict !== 'appropriate');
    if (problems.length === 0) {
      // No problems, but still surface the request's tokens for accounting.
      return [appropriateDraft(evidence, usage, model)];
    }

    const byId = new Map(evidence.fields.map((f) => [f.id, f]));

    return problems.map((finding, index) => {
      const lowConfidence = finding.confidence < MIN_CONFIDENCE;
      const category: FormVerdict =
        lowConfidence && finding.verdict !== 'insufficient_evidence'
          ? 'insufficient_evidence'
          : finding.verdict;
      const field = byId.get(finding.id);

      return {
        skill: this.id,
        pageUrl: evidence.pageUrl,
        // Map the model's id back to the real selector; drop unknown ids.
        selector: field?.selector,
        category,
        // Report the criterion of the originally judged verdict, so a downgrade
        // to insufficient_evidence still records what was assessed.
        wcag: WCAG_FOR_VERDICT[finding.verdict],
        severity: severityForVerdict(category),
        confidence: finding.confidence,
        needsHumanReview: category === 'insufficient_evidence' || lowConfidence,
        message: finding.rationale,
        suggestion: finding.suggestedText ?? undefined,
        details: {
          verdict: finding.verdict,
          controlType: field?.controlType ?? null,
        },
        // Attribute the single request's tokens to the first draft only so the
        // runner sums usage across the array without double-counting.
        usage: index === 0 ? usage : { inputTokens: 0, outputTokens: 0 },
        model,
      };
    });
  }

  /** Extracts the labellable form-control inventory entirely in the browser. */
  private extract(page: Page): Promise<FieldDescriptor[]> {
    return page.evaluate(
      ({ maxFields, nameMax, descMax }) => {
        const collapse = (value: string | null | undefined): string =>
          (value ?? '').replace(/\s+/g, ' ').trim();

        const isVisible = (el: Element): boolean => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none'
          );
        };

        // A short, unique-ish CSS path so clients can locate the element. The
        // page-level skill takes no screenshot, so this string is the finding's
        // only locator.
        const cssPath = (el: Element): string => {
          const parts: string[] = [];
          let node: Element | null = el;
          while (node && node.nodeType === 1 && parts.length < 5) {
            if (node.id) {
              parts.unshift(`#${CSS.escape(node.id)}`);
              break;
            }
            let sel = node.tagName.toLowerCase();
            const parent: Element | null = node.parentElement;
            if (parent) {
              const sameTag = Array.from(parent.children).filter(
                (c) => c.tagName === node!.tagName,
              );
              if (sameTag.length > 1) {
                sel += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
              }
            }
            parts.unshift(sel);
            node = node.parentElement;
          }
          return parts.join(' > ');
        };

        const textFromIds = (ids: string | null): string => {
          if (!ids) return '';
          return collapse(
            ids
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent ?? '')
              .join(' '),
          );
        };

        // Accessible name of a form control, following the priority browsers /
        // screen readers use: aria-labelledby → aria-label → associated <label>
        // (for= or wrapping) → placeholder → title. Returns the source so the
        // model can weigh how the label was authored.
        const accessibleName = (
          el: HTMLElement,
        ): { text: string; source: string | null } => {
          const labelledby = textFromIds(el.getAttribute('aria-labelledby'));
          if (labelledby) {
            return { text: labelledby, source: 'aria-labelledby' };
          }

          const ariaLabel = collapse(el.getAttribute('aria-label'));
          if (ariaLabel) return { text: ariaLabel, source: 'aria-label' };

          const id = el.getAttribute('id');
          if (id) {
            const forLabel = document.querySelector<HTMLElement>(
              `label[for="${CSS.escape(id)}"]`,
            );
            const forText = collapse(forLabel?.textContent);
            if (forText) return { text: forText, source: 'label' };
          }
          const wrapping = el.closest('label');
          if (wrapping) {
            const wrapText = collapse(wrapping.textContent);
            if (wrapText) return { text: wrapText, source: 'wrapping-label' };
          }

          const placeholder = collapse(el.getAttribute('placeholder'));
          if (placeholder) return { text: placeholder, source: 'placeholder' };

          const title = collapse(el.getAttribute('title'));
          if (title) return { text: title, source: 'title' };

          return { text: '', source: null };
        };

        const controlTypeOf = (el: HTMLElement): string => {
          const tag = el.tagName.toLowerCase();
          if (tag === 'input') {
            return (el.getAttribute('type') || 'text').toLowerCase();
          }
          if (tag === 'select' || tag === 'textarea') return tag;
          const role = el.getAttribute('role');
          return role || tag;
        };

        const constraintsOf = (el: HTMLElement): string => {
          const bits: string[] = [];
          const pattern = el.getAttribute('pattern');
          if (pattern) bits.push(`pattern=${pattern}`);
          const inputmode = el.getAttribute('inputmode');
          if (inputmode) bits.push(`inputmode=${inputmode}`);
          const min = el.getAttribute('min');
          if (min !== null) bits.push(`min=${min}`);
          const max = el.getAttribute('max');
          if (max !== null) bits.push(`max=${max}`);
          const maxlength = el.getAttribute('maxlength');
          if (maxlength !== null) bits.push(`maxlength=${maxlength}`);
          return bits.join(' ').slice(0, 120);
        };

        // Non-hidden input types that are labellable data-entry controls.
        const EXCLUDED_INPUT_TYPES = new Set([
          'hidden',
          'submit',
          'button',
          'reset',
          'image',
        ]);

        const controls = Array.from(
          document.querySelectorAll<HTMLElement>(
            'input, select, textarea, [role="textbox"], [role="combobox"], [role="spinbutton"], [role="searchbox"], [role="listbox"]',
          ),
        ).filter((el) => {
          if (el.closest('[aria-hidden="true"]')) return false;
          if ((el as HTMLInputElement).disabled) return false;
          if (!isVisible(el)) return false;
          if (el.tagName.toLowerCase() === 'input') {
            const type = (el.getAttribute('type') || 'text').toLowerCase();
            if (EXCLUDED_INPUT_TYPES.has(type)) return false;
          }
          return true;
        });

        const fields: FieldDescriptor[] = [];
        for (const el of controls) {
          if (fields.length >= maxFields) break;

          const name = accessibleName(el);
          const placeholder = collapse(el.getAttribute('placeholder'));
          const describedby = textFromIds(
            el.getAttribute('aria-describedby'),
          ).slice(0, descMax);
          const constraints = constraintsOf(el);

          fields.push({
            id: `I${fields.length + 1}`,
            selector: cssPath(el),
            controlType: controlTypeOf(el),
            name: name.text.slice(0, nameMax),
            nameSource: name.source as FieldDescriptor['nameSource'],
            placeholder: placeholder
              ? placeholder.slice(0, nameMax)
              : undefined,
            describedby: describedby || undefined,
            constraints: constraints || undefined,
          });
        }

        return fields;
      },
      { maxFields: MAX_FIELDS, nameMax: NAME_MAX, descMax: DESC_MAX },
    );
  }
}

/** Maps a verdict category to the client-facing severity. */
export function severityForVerdict(verdict: FormVerdict): IssueImpact {
  switch (verdict) {
    case 'missing_instructions':
      return IssueImpact.SERIOUS;
    case 'label_not_descriptive':
      return IssueImpact.MODERATE;
    default:
      return IssueImpact.MINOR;
  }
}

/** Bookkeeping draft when every control is clear (kept so tokens are tracked). */
function appropriateDraft(
  evidence: FormEvidence,
  usage: { inputTokens: number; outputTokens: number },
  model: string,
): AgentFindingDraft {
  return {
    skill: AgentSkill.FORM_LABELS,
    pageUrl: evidence.pageUrl,
    category: 'appropriate',
    severity: IssueImpact.MINOR,
    confidence: 1,
    message: 'Every form control is clearly labeled and instructed.',
    usage,
    model,
  };
}

const FORM_LABELS_SYSTEM_PROMPT = `You audit WCAG 2.2 for one thing: the CLARITY of each form control's visible label and instructions. Every control already has an accessible name.

Out of scope — NEVER report: missing/empty names, title-only labels, multiple labels, missing button/select names, required state, placeholder-as-sole-label, radio/checkbox grouping, autocomplete tokens. Deterministic tooling owns all of these. Judge ONLY these two quality gaps:

- label_not_descriptive (2.4.6, AA): a present label that is uninformative or ambiguous for the field's purpose or among its sibling fields (e.g. "Name" among three name fields, "Value", "Field 1"). Judge only the WORDS — a name marked "[via placeholder]" is NOT a defect for that reason; weigh those words like any other label.
- missing_instructions (3.3.2, A): a field that plainly needs a format/constraint hint (a date, a password with rules, a pattern, a code) gives none — not in its label, placeholder, or described-by text. Do NOT demand instructions for self-explanatory fields (a plain "Email" or "Full name"). A "constraints" hint means a machine rule exists; if the user is never told it in text, that is missing_instructions.
- appropriate: label clear and any needed instructions present.
- insufficient_evidence: too little to judge reliably; prefer this over guessing.

Report only real problems; return an empty findings array when every control is clear. Reference each finding by its exact bracketed id (e.g. I1). Set "suggestedText" to a better label or the instruction to add, else null. Keep each "rationale" under 50 words.`;

/** Renders the form inventory into a compact, one-line-per-field prompt. */
export function buildFormPrompt(evidence: FormEvidence): string {
  const lines: string[] = [
    `Page: ${evidence.pageUrl}`,
    '',
    'Form controls, each with a bracketed id. Names are already present; judge only label clarity (2.4.6) and whether needed instructions are given (3.3.2). Do not report missing/title-only/multiple labels or missing button/select names:',
  ];
  for (const field of evidence.fields) {
    const via = field.nameSource ? ` [via ${field.nameSource}]` : '';
    const placeholder = field.placeholder
      ? ` placeholder=${JSON.stringify(field.placeholder)}`
      : '';
    const desc = field.describedby
      ? ` desc:${JSON.stringify(field.describedby)}`
      : '';
    const constraints = field.constraints ? ` [${field.constraints}]` : '';
    lines.push(
      `[${field.id}] ${JSON.stringify(field.name)}${via} type=${field.controlType}${placeholder}${desc}${constraints}`,
    );
  }
  return lines.join('\n');
}
