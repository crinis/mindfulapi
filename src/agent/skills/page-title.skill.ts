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

/** Longest title text kept (titles are short; guards runaway markup). */
const TITLE_MAX = 200;
/** Longest heading text kept per topic-context heading. */
const HEADING_MAX = 120;
/**
 * Max headings collected as topic context. The `<h1>` (and a couple of
 * subheadings) is enough to establish the page topic the title is judged
 * against — more only spends tokens without changing the verdict.
 */
const MAX_HEADINGS = 4;
/** Longest meta description kept. */
const DESC_MAX = 200;
/** Longest suggested replacement title kept. */
const SUGGEST_MAX = 200;

/**
 * Verdicts the model may return. The one case axe already reports
 * deterministically — a missing or empty `<title>` (`document-title`) — is
 * intentionally absent so the model cannot duplicate it; the skill only runs
 * when a non-empty title exists.
 */
const TITLE_VERDICTS = [
  'appropriate',
  'generic_or_boilerplate',
  'not_descriptive',
  'insufficient_evidence',
] as const;

type TitleVerdict = (typeof TITLE_VERDICTS)[number];

/**
 * Maps each verdict to the WCAG success criterion it evaluates. Placeholder /
 * boilerplate titles and titles that fail to describe the page both fail 2.4.2
 * Page Titled (Level A).
 */
const WCAG_FOR_VERDICT: Record<TitleVerdict, string | null> = {
  appropriate: null,
  generic_or_boilerplate: '2.4.2',
  not_descriptive: '2.4.2',
  insufficient_evidence: null,
};

/**
 * Structured page-title verdict. There is exactly one `<title>` per page, so —
 * unlike the multi-unit page skills — this is a single verdict object, not a
 * findings array. Every field is required (`suggestedTitle` is nullable, not
 * optional): OpenAI strict mode rejects a schema whose `required` array omits a
 * property, so optional fields must be modeled as nullable.
 */
export const pageTitleSchema = z.object({
  verdict: z.enum(TITLE_VERDICTS),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(400),
  suggestedTitle: z.string().max(SUGGEST_MAX).nullable(),
});

type PageTitleResult = z.infer<typeof pageTitleSchema>;

/**
 * Returned when the model fails to produce a valid verdict. A degraded request
 * yields a benign bookkeeping draft, never a false positive — mirrors
 * link-purpose's empty-findings fallback.
 */
const SAFE_RESULT: PageTitleResult = {
  verdict: 'appropriate',
  confidence: 0,
  rationale: 'unavailable',
  suggestedTitle: null,
};

/** A heading captured purely as topic context for judging the title. */
interface HeadingContext {
  level: number;
  text: string;
}

/** Page-level evidence: the title plus enough content to judge it. */
export interface PageTitleEvidence extends Evidence {
  pageUrl: string;
  /** The page's `<title>` text (already confirmed non-empty). */
  title: string;
  /** Top headings (h1/h2) establishing the page's actual topic. */
  headings: HeadingContext[];
  /** `<meta name="description">` content, when present. */
  metaDescription: string | null;
}

/** What {@link PageTitleSkill.extract} returns from the browser. */
type TitleExtract = Omit<PageTitleEvidence, 'pageUrl' | 'selector'>;

/**
 * Page-level skill judging whether the page's `<title>` describes its topic or
 * purpose — the semantic gap axe-core cannot close. axe's `document-title` only
 * reports a *missing or empty* title; this skill judges the *quality* of a
 * title that is present against WCAG 2.4.2 (Level A) and never re-reports the
 * empty case. Cross-page title *uniqueness* (also part of 2.4.2) is out of
 * scope: a page-scoped skill sees only one page.
 */
@Injectable()
export class PageTitleSkill implements AuditSkill<PageTitleEvidence> {
  readonly id = AgentSkill.PAGE_TITLE;
  readonly granularity = 'page' as const;
  readonly order = 50;

  private readonly logger = new Logger(PageTitleSkill.name);

  async collect(page: Page, ctx: CollectContext): Promise<PageTitleEvidence[]> {
    // A page-level skill consumes a single unit; nothing to do if the scan
    // budget is exhausted.
    if (ctx.remainingUnits <= 0) {
      return [];
    }

    let extracted: TitleExtract | null;
    try {
      extracted = await this.extract(page);
    } catch (error) {
      this.logger.debug(
        `Title extraction failed on ${ctx.pageUrl}: ${String(error)}`,
      );
      return [];
    }

    // No (or empty) title means the deterministic `document-title` rule owns
    // it — nothing only a model can judge, so skip the request.
    if (!extracted) {
      return [];
    }

    return [{ pageUrl: ctx.pageUrl, ...extracted }];
  }

  async evaluate(
    evidence: PageTitleEvidence,
    harness: AgentHarnessService,
  ): Promise<AgentFindingDraft[]> {
    const { data, usage, model } = await harness.evaluateStructured({
      system: PAGE_TITLE_SYSTEM_PROMPT,
      prompt: buildTitlePrompt(evidence),
      images: [],
      schema: pageTitleSchema,
      fallback: SAFE_RESULT,
      skill: this.id,
    });

    if (data.verdict === 'appropriate') {
      // No problem, but still surface the request's tokens for accounting.
      return [appropriateDraft(evidence, usage, model)];
    }

    const lowConfidence = data.confidence < MIN_CONFIDENCE;
    const category: TitleVerdict =
      lowConfidence && data.verdict !== 'insufficient_evidence'
        ? 'insufficient_evidence'
        : data.verdict;

    return [
      {
        skill: this.id,
        pageUrl: evidence.pageUrl,
        // The page's title element is the single locator for this finding.
        selector: 'title',
        category,
        // Report the criterion of the originally judged verdict, so a downgrade
        // to insufficient_evidence still records what was assessed.
        wcag: WCAG_FOR_VERDICT[data.verdict],
        severity: severityForVerdict(category),
        confidence: data.confidence,
        needsHumanReview: category === 'insufficient_evidence' || lowConfidence,
        message: data.rationale,
        suggestion: data.suggestedTitle ?? undefined,
        details: { verdict: data.verdict },
        usage,
        model,
      },
    ];
  }

  /** Extracts the title and topic context entirely in the browser. */
  private extract(page: Page): Promise<TitleExtract | null> {
    return page.evaluate(
      ({ titleMax, headingMax, maxHeadings, descMax }) => {
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

        const title = collapse(document.title).slice(0, titleMax);
        // Empty/missing title is the deterministic case axe owns.
        if (!title) return null;

        const headings: { level: number; text: string }[] = [];
        const nodes = Array.from(
          document.querySelectorAll<HTMLElement>('h1, h2'),
        );
        for (const el of nodes) {
          if (el.closest('[aria-hidden="true"]') || !isVisible(el)) continue;
          const text = collapse(el.textContent).slice(0, headingMax);
          if (!text) continue;
          headings.push({ level: Number(el.tagName.slice(1)), text });
          if (headings.length >= maxHeadings) break;
        }

        const metaEl = document.querySelector('meta[name="description"]');
        const metaRaw = collapse(metaEl?.getAttribute('content'));
        const metaDescription = metaRaw ? metaRaw.slice(0, descMax) : null;

        return { title, headings, metaDescription };
      },
      {
        titleMax: TITLE_MAX,
        headingMax: HEADING_MAX,
        maxHeadings: MAX_HEADINGS,
        descMax: DESC_MAX,
      },
    );
  }
}

/** Maps a verdict category to the client-facing severity. */
export function severityForVerdict(verdict: TitleVerdict): IssueImpact {
  switch (verdict) {
    case 'generic_or_boilerplate':
      return IssueImpact.SERIOUS;
    case 'not_descriptive':
      return IssueImpact.MODERATE;
    default:
      return IssueImpact.MINOR;
  }
}

/** Bookkeeping draft when the title is clear (kept so tokens are tracked). */
function appropriateDraft(
  evidence: PageTitleEvidence,
  usage: { inputTokens: number; outputTokens: number },
  model: string,
): AgentFindingDraft {
  return {
    skill: AgentSkill.PAGE_TITLE,
    pageUrl: evidence.pageUrl,
    category: 'appropriate',
    severity: IssueImpact.MINOR,
    confidence: 1,
    message: 'The page title clearly describes the page.',
    usage,
    model,
  };
}

const PAGE_TITLE_SYSTEM_PROMPT = `You audit WCAG 2.4.2 Page Titled (Level A): does the page's <title> describe THIS page's topic or purpose? The title is present and non-empty (missing titles are handled elsewhere) and you see one page only, so do not judge cross-page uniqueness. Use the headings and meta description as the page's actual topic.

Verdicts:
- generic_or_boilerplate: a placeholder/default ("Untitled Document", "Document", "New Page", "Home", "Welcome", "index") or a bare site/brand name with no page-specific topic.
- not_descriptive: a real title that still fails to convey what the page is about, or that contradicts the headings/meta description.
- appropriate: the title identifies the page's topic. A brand/site name alongside a real page topic (e.g. "Blue Widget – Specs & Pricing | Acme Corp") is good — never flag it.
- insufficient_evidence: too little content to judge; prefer this over guessing.

SEO and accessibility agree here: never flag a title for containing the brand name, its length, or its keywords. Any suggestedTitle must KEEP the brand and ADD the missing page topic, else null. Rationale under 40 words.`;

/** Renders the title and its topic context into a compact prompt. */
export function buildTitlePrompt(evidence: PageTitleEvidence): string {
  const [primary, ...rest] = evidence.headings;
  const lines: string[] = [
    `Page: ${evidence.pageUrl}`,
    `Title: ${JSON.stringify(evidence.title)}`,
    `Primary heading${primary ? ` (h${primary.level})` : ''}: ${
      primary ? JSON.stringify(primary.text) : 'none'
    }`,
  ];
  const others =
    rest.length > 0
      ? rest.map((h) => `h${h.level} ${JSON.stringify(h.text)}`).join('; ')
      : 'none';
  lines.push(`Other headings: ${others}`);
  lines.push(
    `Meta description: ${
      evidence.metaDescription
        ? JSON.stringify(evidence.metaDescription)
        : 'none'
    }`,
  );
  return lines.join('\n');
}
