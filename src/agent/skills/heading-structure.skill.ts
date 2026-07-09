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

/** Max headings included in the outline (token bound). */
const MAX_HEADINGS = 60;
/** Chars of following content captured per heading (descriptiveness signal). */
const HEADING_SNIPPET = 160;
/** A sectioning element needs at least this much text to warrant a heading. */
const SECTION_MIN_TEXT = 600;
/** Chars of an unheaded section's content included as context. */
const SECTION_SNIPPET = 200;
/** Max unheaded-section candidates surfaced. */
const MAX_SECTIONS = 8;
/** Longest text a "fake heading" candidate may contain (headings are short). */
const FAKE_MAX_TEXT = 120;
/** Following content a candidate must head to count as a heading, in chars. */
const FAKE_FOLLOWING_MIN = 40;
/** Font-size multiple over body text that reads as prominent. */
const FAKE_FONT_SCALE = 1.2;
/** Font weight at/above which text reads as bold. */
const FAKE_WEIGHT_MIN = 600;
/** Max fake-heading candidates surfaced. */
const MAX_FAKE = 10;
/** Max findings the model may return in one page request. */
const MAX_FINDINGS = 30;

/**
 * Verdicts the model may return. Structural problems that axe already reports
 * deterministically — skipped levels, empty headings, missing `<h1>` — are
 * intentionally absent so the model cannot duplicate them.
 */
const HEADING_VERDICTS = [
  'appropriate',
  'not_descriptive',
  'vague_or_generic',
  'duplicate',
  'h1_topic_mismatch',
  'missing_section_heading',
  'mis_nested',
  'fake_heading',
  'insufficient_evidence',
] as const;

type HeadingVerdict = (typeof HEADING_VERDICTS)[number];

/** Maps each verdict to the WCAG success criterion it evaluates. */
const WCAG_FOR_VERDICT: Record<HeadingVerdict, string | null> = {
  appropriate: null,
  not_descriptive: '2.4.6',
  vague_or_generic: '2.4.6',
  duplicate: '2.4.6',
  h1_topic_mismatch: '2.4.6',
  missing_section_heading: '2.4.10',
  mis_nested: '1.3.1',
  fake_heading: '1.3.1',
  insufficient_evidence: null,
};

/**
 * Structured page verdict. Every field is required (`suggested*` are nullable,
 * not optional): OpenAI strict mode rejects a schema whose `required` array
 * omits a property, so optional fields must be modeled as nullable.
 */
export const headingStructureSchema = z.object({
  findings: z
    .array(
      z.object({
        selector: z.string(),
        verdict: z.enum(HEADING_VERDICTS),
        confidence: z.number().min(0).max(1),
        rationale: z.string().max(400),
        suggestedText: z.string().max(300).nullable(),
        suggestedLevel: z.number().int().min(1).max(6).nullable(),
      }),
    )
    .max(MAX_FINDINGS),
});

type HeadingStructureResult = z.infer<typeof headingStructureSchema>;

/** Returned when the model fails to produce a valid verdict. */
const NO_FINDINGS: HeadingStructureResult = { findings: [] };

/** One heading in the page outline. */
export interface HeadingDescriptor {
  selector: string;
  level: number;
  tag: string;
  text: string;
  landmark?: string;
  snippet?: string;
}

/** A styled block that may be an unmarked heading. */
export interface FakeHeadingCandidate {
  selector: string;
  text: string;
  fontSizePx: number;
  fontWeight: number;
}

/** A sectioning element that has substantial content but no heading. */
export interface UnheadedSection {
  selector: string;
  snippet: string;
  textLength: number;
}

/** Page-level evidence: the whole heading outline plus structural candidates. */
export interface HeadingEvidence extends Evidence {
  pageTitle: string;
  headings: HeadingDescriptor[];
  fakeHeadingCandidates: FakeHeadingCandidate[];
  unheadedSections: UnheadedSection[];
}

/**
 * Page-level skill judging heading *semantics* axe-core cannot: descriptive,
 * meaningful text (WCAG 2.4.6), content sections that lack a heading (2.4.10 —
 * the AAA heading criterion), and headings faked with styled markup (1.3.1).
 * Deterministic structural checks (skipped levels, empty headings, missing
 * `<h1>`) are left to axe-core and never re-reported here.
 */
@Injectable()
export class HeadingStructureSkill implements AuditSkill<HeadingEvidence> {
  readonly id = AgentSkill.HEADING_STRUCTURE;
  readonly granularity = 'page' as const;
  readonly order = 20;

  private readonly logger = new Logger(HeadingStructureSkill.name);

  async collect(page: Page, ctx: CollectContext): Promise<HeadingEvidence[]> {
    // A page-level skill consumes a single unit; nothing to do if the scan
    // budget is exhausted.
    if (ctx.remainingUnits <= 0) {
      return [];
    }

    let extracted: Omit<HeadingEvidence, keyof Evidence>;
    try {
      extracted = await this.extract(page);
    } catch (error) {
      this.logger.debug(
        `Heading extraction failed on ${ctx.pageUrl}: ${String(error)}`,
      );
      return [];
    }

    // No headings, styled candidates, or unheaded sections means there is
    // nothing only a model can judge — skip the request entirely.
    if (
      extracted.headings.length === 0 &&
      extracted.fakeHeadingCandidates.length === 0 &&
      extracted.unheadedSections.length === 0
    ) {
      return [];
    }

    return [{ pageUrl: ctx.pageUrl, ...extracted }];
  }

  async evaluate(
    evidence: HeadingEvidence,
    harness: AgentHarnessService,
  ): Promise<AgentFindingDraft[]> {
    const { data, usage, model } = await harness.evaluateStructured({
      system: HEADING_SYSTEM_PROMPT,
      prompt: buildHeadingPrompt(evidence),
      images: [],
      schema: headingStructureSchema,
      fallback: NO_FINDINGS,
      skill: this.id,
    });

    const problems = data.findings.filter((f) => f.verdict !== 'appropriate');
    if (problems.length === 0) {
      // No problems, but still surface the request's tokens for accounting.
      return [appropriateDraft(evidence, usage, model)];
    }

    const knownSelectors = new Set<string>([
      ...evidence.headings.map((h) => h.selector),
      ...evidence.fakeHeadingCandidates.map((c) => c.selector),
      ...evidence.unheadedSections.map((s) => s.selector),
    ]);

    return problems.map((finding, index) => {
      const lowConfidence = finding.confidence < MIN_CONFIDENCE;
      const category: HeadingVerdict =
        lowConfidence && finding.verdict !== 'insufficient_evidence'
          ? 'insufficient_evidence'
          : finding.verdict;

      return {
        skill: this.id,
        pageUrl: evidence.pageUrl,
        // Only trust a selector the model echoed back from the evidence.
        selector: knownSelectors.has(finding.selector)
          ? finding.selector
          : undefined,
        category,
        // Report the criterion of the originally judged verdict, so a
        // downgrade to insufficient_evidence still records what was assessed.
        wcag: WCAG_FOR_VERDICT[finding.verdict],
        severity: severityForVerdict(category),
        confidence: finding.confidence,
        needsHumanReview: category === 'insufficient_evidence' || lowConfidence,
        message: finding.rationale,
        suggestion: finding.suggestedText ?? undefined,
        details: {
          verdict: finding.verdict,
          suggestedLevel: finding.suggestedLevel,
        },
        // Attribute the single request's tokens to the first draft only so the
        // runner sums usage across the array without double-counting.
        usage: index === 0 ? usage : { inputTokens: 0, outputTokens: 0 },
        model,
      };
    });
  }

  /** Extracts the outline + structural candidates entirely in the browser. */
  private extract(page: Page): Promise<Omit<HeadingEvidence, keyof Evidence>> {
    return page.evaluate(
      ({
        maxHeadings,
        headingSnippet,
        sectionMinText,
        sectionSnippet,
        maxSections,
        fakeMaxText,
        fakeFollowingMin,
        fakeFontScale,
        fakeWeightMin,
        maxFake,
      }) => {
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

        const nearestLandmark = (el: Element): string | undefined => {
          const landmark = el.closest(
            'header,nav,main,aside,footer,section,article,[role="banner"],[role="navigation"],[role="main"],[role="complementary"],[role="contentinfo"],[role="region"]',
          );
          if (!landmark) return undefined;
          const role = landmark.getAttribute('role');
          return role || landmark.tagName.toLowerCase();
        };

        // --- Heading outline ---------------------------------------------
        const headingEls = Array.from(
          document.querySelectorAll<HTMLElement>(
            'h1,h2,h3,h4,h5,h6,[role="heading"]',
          ),
        ).filter((el) => !el.closest('[aria-hidden="true"]') && isVisible(el));

        const headings = headingEls.slice(0, maxHeadings).map((el, i) => {
          const tag = el.tagName.toLowerCase();
          const level = /^h[1-6]$/.test(tag)
            ? Number(tag[1])
            : Number.parseInt(el.getAttribute('aria-level') ?? '', 10) || 2;

          // Content between this heading and the next, via a DOM Range.
          let snippet = '';
          try {
            const range = document.createRange();
            range.setStartAfter(el);
            const next = headingEls[i + 1];
            if (next) range.setEndBefore(next);
            else range.setEndAfter(document.body);
            snippet = collapse(range.toString()).slice(0, headingSnippet);
          } catch {
            snippet = '';
          }

          return {
            selector: cssPath(el),
            level,
            tag,
            text: collapse(el.textContent),
            landmark: nearestLandmark(el),
            snippet: snippet || undefined,
          };
        });

        // --- Fake-heading candidates (styled text acting as a heading) ----
        const fakeHeadingCandidates: Array<{
          selector: string;
          text: string;
          fontSizePx: number;
          fontWeight: number;
        }> = [];
        const bodyFontSize =
          Number.parseFloat(window.getComputedStyle(document.body).fontSize) ||
          16;
        for (const el of Array.from(
          document.querySelectorAll<HTMLElement>('p,div,span,b,strong'),
        )) {
          if (
            el.closest(
              'h1,h2,h3,h4,h5,h6,[role="heading"],a,button,label,[aria-hidden="true"]',
            )
          ) {
            continue;
          }
          if (!isVisible(el)) continue;
          const text = collapse(el.textContent);
          if (text.length < 2 || text.length > fakeMaxText) continue;

          const style = window.getComputedStyle(el);
          // Inline emphasis is not a heading; require a block-ish box unless the
          // element is already a block element (p/div).
          const display = style.display;
          const blockish =
            el.tagName === 'P' ||
            el.tagName === 'DIV' ||
            display === 'block' ||
            display === 'flex' ||
            display === 'grid' ||
            display === 'inline-block';
          if (!blockish) continue;

          const weightRaw = style.fontWeight;
          const fontWeight =
            weightRaw === 'bold'
              ? 700
              : weightRaw === 'normal'
                ? 400
                : Number.parseInt(weightRaw, 10) || 400;
          const fontSizePx = Number.parseFloat(style.fontSize) || bodyFontSize;
          const prominent =
            fontWeight >= fakeWeightMin ||
            fontSizePx >= bodyFontSize * fakeFontScale;
          if (!prominent) continue;

          // Must actually head some following content.
          const following = collapse(el.nextElementSibling?.textContent);
          if (following.length < fakeFollowingMin) continue;

          fakeHeadingCandidates.push({
            selector: cssPath(el),
            text,
            fontSizePx: Math.round(fontSizePx),
            fontWeight,
          });
        }
        fakeHeadingCandidates.sort((a, b) => b.fontSizePx - a.fontSizePx);
        fakeHeadingCandidates.length = Math.min(
          fakeHeadingCandidates.length,
          maxFake,
        );

        // --- Unheaded sections (WCAG 2.4.10) ------------------------------
        // Only semantic sectioning elements: the author declared a section but
        // gave it no heading. Plain <div>s are deliberately excluded to avoid
        // speculative findings.
        const unheadedSections: Array<{
          selector: string;
          snippet: string;
          textLength: number;
        }> = [];
        for (const el of Array.from(
          document.querySelectorAll<HTMLElement>(
            'section,article,[role="region"]',
          ),
        )) {
          if (el.closest('[aria-hidden="true"]') || !isVisible(el)) continue;
          if (el.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]')) continue;
          const text = collapse(el.textContent);
          if (text.length < sectionMinText) continue;
          unheadedSections.push({
            selector: cssPath(el),
            snippet: text.slice(0, sectionSnippet),
            textLength: text.length,
          });
          if (unheadedSections.length >= maxSections) break;
        }

        return {
          pageTitle: document.title,
          headings,
          fakeHeadingCandidates,
          unheadedSections,
        };
      },
      {
        maxHeadings: MAX_HEADINGS,
        headingSnippet: HEADING_SNIPPET,
        sectionMinText: SECTION_MIN_TEXT,
        sectionSnippet: SECTION_SNIPPET,
        maxSections: MAX_SECTIONS,
        fakeMaxText: FAKE_MAX_TEXT,
        fakeFollowingMin: FAKE_FOLLOWING_MIN,
        fakeFontScale: FAKE_FONT_SCALE,
        fakeWeightMin: FAKE_WEIGHT_MIN,
        maxFake: MAX_FAKE,
      },
    );
  }
}

/** Maps a verdict category to the client-facing severity. */
export function severityForVerdict(verdict: HeadingVerdict): IssueImpact {
  switch (verdict) {
    case 'fake_heading':
    case 'not_descriptive':
    case 'h1_topic_mismatch':
      return IssueImpact.SERIOUS;
    case 'vague_or_generic':
    case 'duplicate':
    case 'missing_section_heading':
    case 'mis_nested':
      return IssueImpact.MODERATE;
    default:
      return IssueImpact.MINOR;
  }
}

/** Bookkeeping draft when the outline is sound (kept so tokens are tracked). */
function appropriateDraft(
  evidence: HeadingEvidence,
  usage: { inputTokens: number; outputTokens: number },
  model: string,
): AgentFindingDraft {
  return {
    skill: AgentSkill.HEADING_STRUCTURE,
    pageUrl: evidence.pageUrl,
    category: 'appropriate',
    severity: IssueImpact.MINOR,
    confidence: 1,
    message: 'The heading structure is clear, descriptive, and well organized.',
    usage,
    model,
  };
}

const HEADING_SYSTEM_PROMPT = `You are a WCAG 2.2 accessibility expert judging the SEMANTIC QUALITY of a page's heading structure — the goal is Level AAA conformance for headings. You receive the page's heading outline (already validated for structural correctness), styled blocks that might be unmarked headings, and semantic sections that lack a heading.

Deterministic tooling already reports skipped/out-of-order levels, empty headings, and a missing <h1>. NEVER report those — they are out of scope. Judge only what requires understanding the content:

- not_descriptive (WCAG 2.4.6): the heading text does not describe the content of the section that follows it.
- vague_or_generic (2.4.6): non-empty but uninformative for navigation ("More", "Info", "Section 1", "Read more").
- duplicate (2.4.6): repeated identical/near-identical headings that make heading navigation ambiguous.
- h1_topic_mismatch (2.4.6): the top-level heading does not reflect the page's main topic (compare against the page title).
- missing_section_heading (2.4.10, AAA): a listed section contains substantial, self-contained content but has no heading and clearly warrants one. 2.4.10 applies only where sectional organization already exists — do NOT invent headings for trivial or non-sectional content.
- mis_nested (1.3.1): the heading's level is sequential (not skipped) but misrepresents the parent/child relationship — e.g. a sub-topic marked as a sibling. Only flag when clearly wrong.
- fake_heading (1.3.1): a styled paragraph/div that visually reads as a section title but is not a heading element. Prune false positives (bold lead sentences, emphasis) — only flag text that genuinely heads a section.

Report only real problems; return an empty findings array when the outline is sound. Reference each finding by the exact "selector" given in the evidence. Prefer "insufficient_evidence" over guessing. Set "suggestedText"/"suggestedLevel" only when proposing a concrete fix, otherwise null. Keep each "rationale" under 50 words.`;

/** Renders the page evidence into a compact prompt. */
export function buildHeadingPrompt(evidence: HeadingEvidence): string {
  const lines: string[] = [
    `Page title: ${JSON.stringify(evidence.pageTitle)}`,
    '',
    'Heading outline (levels & emptiness already validated — do not re-report those):',
  ];
  if (evidence.headings.length === 0) {
    lines.push('(no headings on the page)');
  }
  for (const h of evidence.headings) {
    const landmark = h.landmark ? ` — in <${h.landmark}>` : '';
    const snippet = h.snippet ? ` — content: ${h.snippet}` : '';
    lines.push(
      `[${h.selector}] level ${h.level} (${h.tag}): ${JSON.stringify(h.text)}${landmark}${snippet}`,
    );
  }

  if (evidence.fakeHeadingCandidates.length > 0) {
    lines.push('', 'Styled blocks that may be unmarked headings:');
    for (const c of evidence.fakeHeadingCandidates) {
      lines.push(
        `[${c.selector}] ${JSON.stringify(c.text)} (font ${c.fontSizePx}px, weight ${c.fontWeight})`,
      );
    }
  }

  if (evidence.unheadedSections.length > 0) {
    lines.push('', 'Sections with no heading (WCAG 2.4.10 candidates):');
    for (const s of evidence.unheadedSections) {
      lines.push(
        `[${s.selector}] (${s.textLength} chars) content: ${s.snippet}`,
      );
    }
  }

  return lines.join('\n');
}
