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

/** Max unique links included in one page request (token bound). */
const MAX_LINKS = 50;
/** Longest accessible name kept (link names are short; guards runaway text). */
const LINK_TEXT_MAX = 200;
/** Chars of surrounding context captured per link (the 2.4.4 signal). */
const CONTEXT_SNIPPET = 140;
/** Longest destination string kept per link. */
const DEST_MAX = 80;
/** Max findings the model may return in one page request. */
const MAX_FINDINGS = 40;

/**
 * Verdicts the model may return. Problems axe already reports deterministically
 * — an empty accessible name (`link-name`) and identical names pointing to
 * different destinations (`identical-links-same-purpose`) — are intentionally
 * absent so the model cannot duplicate them.
 */
const LINK_VERDICTS = [
  'appropriate',
  'vague_or_generic',
  'not_descriptive',
  'url_as_text',
  'unclear_without_context',
  'insufficient_evidence',
] as const;

type LinkVerdict = (typeof LINK_VERDICTS)[number];

/**
 * Maps each verdict to the WCAG success criterion it evaluates. Generic,
 * non-descriptive, and raw-URL link text fail 2.4.4 Link Purpose (In Context,
 * Level A); text that only resolves via its surroundings fails the stricter
 * 2.4.9 Link Purpose (Link Only, Level AAA).
 */
const WCAG_FOR_VERDICT: Record<LinkVerdict, string | null> = {
  appropriate: null,
  vague_or_generic: '2.4.4',
  not_descriptive: '2.4.4',
  url_as_text: '2.4.4',
  unclear_without_context: '2.4.9',
  insufficient_evidence: null,
};

/**
 * Structured page verdict. Every field is required (`suggestedText` is
 * nullable, not optional): OpenAI strict mode rejects a schema whose `required`
 * array omits a property, so optional fields must be modeled as nullable.
 */
export const linkPurposeSchema = z.object({
  findings: z
    .array(
      z.object({
        id: z.string(),
        verdict: z.enum(LINK_VERDICTS),
        confidence: z.number().min(0).max(1),
        rationale: z.string().max(400),
        suggestedText: z.string().max(300).nullable(),
      }),
    )
    .max(MAX_FINDINGS),
});

type LinkPurposeResult = z.infer<typeof linkPurposeSchema>;

/** Returned when the model fails to produce a valid verdict. */
const NO_FINDINGS: LinkPurposeResult = { findings: [] };

/** One link in the page's link inventory. */
export interface LinkDescriptor {
  /**
   * Short stable id (`L1`, `L2`, …) the model echoes back. Models do not
   * reliably reproduce a long CSS path verbatim, so findings are keyed by this
   * token and mapped back to {@link LinkDescriptor.selector} for the client.
   */
  id: string;
  /** Real CSS selector emitted to the client (the finding's only locator). */
  selector: string;
  /** Computed accessible name (text, aria-label, title, or wrapped image alt). */
  text: string;
  /** How the accessible name was derived (helps judge intent). */
  nameSource: 'text' | 'aria-label' | 'aria-labelledby' | 'title' | 'image-alt';
  /** Compact destination (host + path + hash, or mailto:/tel:), when present. */
  destination?: string;
  /** Surrounding text that could disambiguate the link (2.4.4 vs 2.4.9). */
  context?: string;
  /** Nearest landmark (nav/main/footer/...), when inside one. */
  landmark?: string;
  /** How many identical (name + destination) links were collapsed into this. */
  count: number;
}

/** Page-level evidence: the deduplicated inventory of named links. */
export interface LinkEvidence extends Evidence {
  pageUrl: string;
  links: LinkDescriptor[];
}

/**
 * Page-level skill judging whether a link's accessible name conveys its
 * purpose — the semantic gap axe-core cannot close. axe reports a *missing*
 * name (`link-name`) and identical names resolving to different destinations
 * (`identical-links-same-purpose`); this skill judges name *quality* against
 * WCAG 2.4.4 (Level A) and 2.4.9 (Level AAA) and never re-reports those.
 */
@Injectable()
export class LinkPurposeSkill implements AuditSkill<LinkEvidence> {
  readonly id = AgentSkill.LINK_PURPOSE;
  readonly granularity = 'page' as const;
  readonly order = 30;

  private readonly logger = new Logger(LinkPurposeSkill.name);

  async collect(page: Page, ctx: CollectContext): Promise<LinkEvidence[]> {
    // A page-level skill consumes a single unit; nothing to do if the scan
    // budget is exhausted.
    if (ctx.remainingUnits <= 0) {
      return [];
    }

    let links: LinkDescriptor[];
    try {
      links = await this.extract(page);
    } catch (error) {
      this.logger.debug(
        `Link extraction failed on ${ctx.pageUrl}: ${String(error)}`,
      );
      return [];
    }

    // No named links means nothing only a model can judge — skip the request.
    if (links.length === 0) {
      return [];
    }

    return [{ pageUrl: ctx.pageUrl, links }];
  }

  async evaluate(
    evidence: LinkEvidence,
    harness: AgentHarnessService,
  ): Promise<AgentFindingDraft[]> {
    const { data, usage, model } = await harness.evaluateStructured({
      system: LINK_PURPOSE_SYSTEM_PROMPT,
      prompt: buildLinkPrompt(evidence),
      images: [],
      schema: linkPurposeSchema,
      fallback: NO_FINDINGS,
      skill: this.id,
    });

    const problems = data.findings.filter((f) => f.verdict !== 'appropriate');
    if (problems.length === 0) {
      // No problems, but still surface the request's tokens for accounting.
      return [appropriateDraft(evidence, usage, model)];
    }

    const byId = new Map(evidence.links.map((l) => [l.id, l]));

    return problems.map((finding, index) => {
      const lowConfidence = finding.confidence < MIN_CONFIDENCE;
      const category: LinkVerdict =
        lowConfidence && finding.verdict !== 'insufficient_evidence'
          ? 'insufficient_evidence'
          : finding.verdict;
      const link = byId.get(finding.id);

      return {
        skill: this.id,
        pageUrl: evidence.pageUrl,
        // Map the model's id back to the real selector; drop unknown ids.
        selector: link?.selector,
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
          linkText: link?.text ?? null,
        },
        // Attribute the single request's tokens to the first draft only so the
        // runner sums usage across the array without double-counting.
        usage: index === 0 ? usage : { inputTokens: 0, outputTokens: 0 },
        model,
      };
    });
  }

  /** Extracts the deduplicated link inventory entirely in the browser. */
  private extract(page: Page): Promise<LinkDescriptor[]> {
    return page.evaluate(
      ({ maxLinks, textMax, contextSnippet, destMax }) => {
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
            'header,nav,main,aside,footer,[role="banner"],[role="navigation"],[role="main"],[role="complementary"],[role="contentinfo"]',
          );
          if (!landmark) return undefined;
          return (
            landmark.getAttribute('role') || landmark.tagName.toLowerCase()
          );
        };

        // Accessible name, following the priority browsers/screen readers use:
        // aria-labelledby → aria-label → text content → wrapped image alt →
        // title. Returns the source so the model can weigh authored vs derived.
        const accessibleName = (
          el: HTMLElement,
        ): {
          text: string;
          source:
            | 'text'
            | 'aria-label'
            | 'aria-labelledby'
            | 'title'
            | 'image-alt';
        } | null => {
          const labelledby = el.getAttribute('aria-labelledby');
          if (labelledby) {
            const text = collapse(
              labelledby
                .split(/\s+/)
                .map((id) => document.getElementById(id)?.textContent ?? '')
                .join(' '),
            );
            if (text) return { text, source: 'aria-labelledby' };
          }
          const ariaLabel = collapse(el.getAttribute('aria-label'));
          if (ariaLabel) return { text: ariaLabel, source: 'aria-label' };

          const own = collapse(el.textContent);
          if (own) return { text: own, source: 'text' };

          // Image-only links derive their name from the image's alt/aria-label.
          const img = el.querySelector<HTMLElement>(
            'img[alt], [role="img"][aria-label], img[aria-label]',
          );
          if (img) {
            const alt = collapse(
              img.getAttribute('alt') || img.getAttribute('aria-label'),
            );
            if (alt) return { text: alt, source: 'image-alt' };
          }

          const title = collapse(el.getAttribute('title'));
          if (title) return { text: title, source: 'title' };
          return null;
        };

        const compactDestination = (el: HTMLElement): string | undefined => {
          const raw = el.getAttribute('href');
          if (!raw) return undefined;
          const trimmed = raw.trim();
          if (!trimmed || trimmed === '#') return undefined;
          if (/^(mailto|tel):/i.test(trimmed)) return trimmed.slice(0, destMax);
          try {
            const url = new URL((el as HTMLAnchorElement).href);
            const compact = `${url.host}${url.pathname}${url.hash}`.replace(
              /\/$/,
              '',
            );
            return compact.slice(0, destMax);
          } catch {
            return trimmed.slice(0, destMax);
          }
        };

        // Surrounding context that could disambiguate the link: the nearest
        // block-level container, minus the link's own name.
        const contextFor = (el: HTMLElement, name: string): string => {
          const container =
            el.closest('li,p,td,th,dd,dt,figcaption,h1,h2,h3,h4,h5,h6') ??
            el.parentElement;
          if (!container) return '';
          let text = collapse(container.textContent);
          if (name) text = collapse(text.replace(name, ' '));
          return text.slice(0, contextSnippet);
        };

        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>('a[href], [role="link"]'),
        );

        const out: LinkDescriptor[] = [];
        const byKey = new Map<string, LinkDescriptor>();

        for (const el of candidates) {
          if (el.closest('[aria-hidden="true"]') || !isVisible(el)) continue;

          const name = accessibleName(el);
          if (!name) continue; // axe owns links with no accessible name

          const destination = compactDestination(el);
          const text = name.text.slice(0, textMax);
          // Collapse links repeated across nav/footer (same name + target) so a
          // duplicated menu costs one line, not dozens, of prompt tokens.
          const key = `${name.source === 'text' ? '' : name.source} ${text.toLowerCase()} ${destination ?? ''}`;
          const existing = byKey.get(key);
          if (existing) {
            existing.count += 1;
            continue;
          }

          if (byKey.size >= maxLinks) continue;

          const descriptor: LinkDescriptor = {
            id: `L${byKey.size + 1}`,
            selector: cssPath(el),
            text,
            nameSource: name.source,
            destination,
            context: contextFor(el, text) || undefined,
            landmark: nearestLandmark(el),
            count: 1,
          };
          byKey.set(key, descriptor);
          out.push(descriptor);
        }

        return out;
      },
      {
        maxLinks: MAX_LINKS,
        textMax: LINK_TEXT_MAX,
        contextSnippet: CONTEXT_SNIPPET,
        destMax: DEST_MAX,
      },
    );
  }
}

/** Maps a verdict category to the client-facing severity. */
export function severityForVerdict(verdict: LinkVerdict): IssueImpact {
  switch (verdict) {
    case 'vague_or_generic':
    case 'not_descriptive':
    case 'url_as_text':
      return IssueImpact.SERIOUS;
    case 'unclear_without_context':
      return IssueImpact.MODERATE;
    default:
      return IssueImpact.MINOR;
  }
}

/** Bookkeeping draft when every link is clear (kept so tokens are tracked). */
function appropriateDraft(
  evidence: LinkEvidence,
  usage: { inputTokens: number; outputTokens: number },
  model: string,
): AgentFindingDraft {
  return {
    skill: AgentSkill.LINK_PURPOSE,
    pageUrl: evidence.pageUrl,
    category: 'appropriate',
    severity: IssueImpact.MINOR,
    confidence: 1,
    message: 'Every link’s text clearly conveys its purpose.',
    usage,
    model,
  };
}

const LINK_PURPOSE_SYSTEM_PROMPT = `You are a WCAG 2.2 accessibility expert judging whether each link's ACCESSIBLE NAME conveys its purpose — the goal is Level AAA conformance (2.4.9 Link Purpose, Link Only) on top of Level A (2.4.4 Link Purpose, In Context).

Deterministic tooling already reports links with NO accessible name and identical names that point to DIFFERENT destinations. NEVER report those — they are out of scope. Judge only the quality of a name that is present:

- vague_or_generic (WCAG 2.4.4, A): the name is uninformative filler that gives no clue to the destination — "click here", "read more", "more", "here", "learn more", "details", "link", "this", "download". These fail even with surrounding context.
- not_descriptive (2.4.4, A): a non-generic name that still does not describe where the link goes or what it does (e.g. mismatched with its destination).
- url_as_text (2.4.4, A): the visible name is a raw URL or path rather than human-readable text, which screen readers announce character by character.
- unclear_without_context (2.4.9, AAA): the name is understandable ONLY together with its surrounding sentence, list item, or heading — it passes 2.4.4 (In Context) but fails 2.4.9 (Link Only). Use this when nearby context resolves the meaning but the link text alone does not.
- appropriate: the name conveys the link's purpose on its own.
- insufficient_evidence: the evidence does not allow a reliable judgment.

Use the "destination" and "context" fields to decide: if the context is what makes an otherwise-thin name clear, prefer unclear_without_context over vague_or_generic. Report only real problems; return an empty findings array when every link is clear. Reference each finding by the exact bracketed id (e.g. L1) shown before each link. Prefer "insufficient_evidence" over guessing. Set "suggestedText" to a better, self-describing link name only when proposing one, otherwise null. Keep each "rationale" under 50 words.`;

/** Renders the link inventory into a compact, one-line-per-link prompt. */
export function buildLinkPrompt(evidence: LinkEvidence): string {
  const lines: string[] = [
    `Page: ${evidence.pageUrl}`,
    '',
    'Links, each with a bracketed id (accessible name → destination — context). Names are already present; do not report missing names or identical-name/different-destination pairs:',
  ];
  for (const link of evidence.links) {
    const dest = link.destination ? ` → ${link.destination}` : ' → (no href)';
    const via = link.nameSource === 'text' ? '' : ` [via ${link.nameSource}]`;
    const landmark = link.landmark ? ` — in <${link.landmark}>` : '';
    const repeated = link.count > 1 ? ` (×${link.count})` : '';
    const context = link.context ? ` — context: ${link.context}` : '';
    lines.push(
      `[${link.id}] ${JSON.stringify(link.text)}${via}${dest}${landmark}${repeated}${context}`,
    );
  }
  return lines.join('\n');
}
