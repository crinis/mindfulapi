import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { z } from 'zod';
import { AgentSkill } from '../../enums/agent-skill.enum';
import { IssueImpact } from '../../enums/issue-impact.enum';
import type { ScannedIssue } from '../../services/axe-accessibility-scanner.service';
import type { AgentHarnessService } from '../harness/agent-harness.service';
import type {
  AgentFindingDraft,
  AuditSkill,
  CollectContext,
  Evidence,
} from './audit-skill.interface';

/** Minimum rendered dimension (px) for an image to be worth reviewing. */
const MIN_RENDERED_PX = 24;

/** Confidence below which a problem verdict is downgraded to human review. */
const MIN_CONFIDENCE = 0.5;

/** Axe rules that already report a missing/invalid accessible name. */
const AXE_ALT_RULES = [
  'image-alt',
  'input-image-alt',
  'role-img-alt',
  'svg-img-alt',
  'object-alt',
  'area-alt',
];

/** Fixed set of verdicts the model may return. */
const IMAGE_ALT_VERDICTS = [
  'appropriate',
  'inaccurate',
  'redundant',
  'decorative_but_meaningful',
  'insufficient_evidence',
] as const;

/** Zod schema forcing the model into a structured, low-hallucination verdict. */
const imageAltVerdictSchema = z.object({
  verdict: z.enum(IMAGE_ALT_VERDICTS),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(600),
  suggestedAlt: z.string().max(300).optional(),
});

type ImageAltVerdictResult = z.infer<typeof imageAltVerdictSchema>;

/** Returned when the model fails to produce a valid verdict. */
const INSUFFICIENT_EVIDENCE: ImageAltVerdictResult = {
  verdict: 'insufficient_evidence',
  confidence: 0,
  rationale: 'The model did not return a valid structured verdict.',
};

/** Descriptor produced in-browser for each candidate image. */
interface ImageDescriptor {
  auditId: string;
  selector: string;
  src?: string;
  role?: string;
  alt: string | null;
  ariaLabel?: string;
  ariaLabelledbyText?: string;
  title?: string;
  figcaption?: string;
  surroundingText?: string;
  width: number;
  height: number;
}

/** Image evidence, including a cropped element screenshot. */
export interface ImageEvidence extends Evidence, ImageDescriptor {
  pageUrl: string;
  selector: string;
  screenshot?: Buffer;
  screenshotMediaType?: string;
}

/**
 * True when an image is axe's responsibility (a missing accessible name), so
 * the agent should NOT re-check it. Mirrors axe's alt-rule criterion using the
 * DOM signal available at collect time: an `<img>` with no `alt` attribute and
 * no ARIA name, and not explicitly marked decorative, is exactly what axe's
 * `image-alt` family flags.
 */
export function imageNeedsAgentReview(descriptor: {
  role?: string;
  alt: string | null;
  ariaLabel?: string;
  ariaLabelledbyText?: string;
  title?: string;
}): boolean {
  const hasAltAttr = descriptor.alt !== null; // present, even if empty (decorative)
  const hasAria =
    !!descriptor.ariaLabel?.trim() || !!descriptor.ariaLabelledbyText?.trim();
  const hasTitle = !!descriptor.title?.trim();
  const declaredDecorative =
    descriptor.role === 'presentation' || descriptor.role === 'none';
  // Anything with an authored (or deliberately empty) name is axe-clean and
  // therefore a quality judgment only a model can make.
  return hasAltAttr || hasAria || hasTitle || declaredDecorative;
}

/**
 * Defensive cross-check: skip an image whose `src` appears in the HTML context
 * of an axe alt-rule violation, so we never duplicate an axe finding even if
 * the DOM heuristic and axe disagree.
 */
export function isCoveredByAxeAltRule(
  src: string | undefined,
  axeIssues: ScannedIssue[],
): boolean {
  if (!src) return false;
  return axeIssues.some(
    (issue) =>
      AXE_ALT_RULES.includes(issue.ruleId) && !!issue.context?.includes(src),
  );
}

/**
 * Skill that judges the quality of an image's *existing* accessible name.
 * Missing names are left to axe-core and deliberately not re-checked.
 */
@Injectable()
export class ImageAltTextSkill implements AuditSkill<ImageEvidence> {
  readonly id = AgentSkill.IMAGE_ALT_TEXT;
  readonly granularity = 'element' as const;
  readonly order = 10;

  private readonly logger = new Logger(ImageAltTextSkill.name);

  async collect(page: Page, ctx: CollectContext): Promise<ImageEvidence[]> {
    const limit = Math.max(
      0,
      Math.min(ctx.maxUnitsPerPage, ctx.remainingUnits),
    );
    if (limit === 0) {
      return [];
    }

    const descriptors = await this.collectDescriptors(page, limit);

    const evidence: ImageEvidence[] = [];
    for (const descriptor of descriptors) {
      if (isCoveredByAxeAltRule(descriptor.src, ctx.axeIssues)) {
        continue;
      }
      let screenshot: Buffer | undefined;
      try {
        screenshot = await page
          .locator(`[data-mfa-audit-id="${descriptor.auditId}"]`)
          .screenshot({ type: 'png', timeout: 5000 });
        if (screenshot.byteLength > ctx.maxImageBytes) {
          this.logger.warn(
            `Dropping oversized screenshot for ${descriptor.selector} on ${ctx.pageUrl}.`,
          );
          screenshot = undefined;
        }
      } catch (error) {
        this.logger.debug(
          `Screenshot failed for ${descriptor.selector} on ${ctx.pageUrl}: ${String(error)}`,
        );
      }
      evidence.push({
        ...descriptor,
        pageUrl: ctx.pageUrl,
        screenshot,
        screenshotMediaType: screenshot ? 'image/png' : undefined,
      });
    }
    return evidence;
  }

  async evaluate(
    evidence: ImageEvidence,
    harness: AgentHarnessService,
  ): Promise<AgentFindingDraft | null> {
    const { data: verdict, usage } = await harness.evaluateStructured({
      system: IMAGE_ALT_SYSTEM_PROMPT,
      prompt: buildImagePrompt(evidence),
      images: evidence.screenshot
        ? [
            {
              data: evidence.screenshot,
              mediaType: evidence.screenshotMediaType ?? 'image/png',
            },
          ]
        : [],
      schema: imageAltVerdictSchema,
      fallback: INSUFFICIENT_EVIDENCE,
    });

    // An accurate accessible name is not a finding — surface only problems.
    if (verdict.verdict === 'appropriate') {
      return { ...emptyDraft(evidence, usage), category: 'appropriate' };
    }

    const lowConfidence = verdict.confidence < MIN_CONFIDENCE;
    const category =
      lowConfidence && verdict.verdict !== 'insufficient_evidence'
        ? 'insufficient_evidence'
        : verdict.verdict;

    return {
      skill: this.id,
      pageUrl: evidence.pageUrl,
      selector: evidence.selector,
      category,
      severity: severityForVerdict(category),
      confidence: verdict.confidence,
      message: verdict.rationale,
      suggestion: verdict.suggestedAlt,
      details: {
        verdict: verdict.verdict,
        currentAlt: evidence.alt,
        needsHumanReview: category === 'insufficient_evidence' || lowConfidence,
      },
      usage,
    };
  }

  /**
   * Runs entirely in the browser: finds candidate images, applies the
   * visibility/size/trigger filter, tags survivors with a stable id, and
   * returns their descriptors. No screenshot is taken for filtered-out images.
   */
  private collectDescriptors(
    page: Page,
    limit: number,
  ): Promise<ImageDescriptor[]> {
    return page.evaluate(
      ({ limit, minPx }) => {
        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>(
            'img, [role="img"], svg[role="img"]',
          ),
        );
        const out: ImageDescriptor[] = [];
        let counter = 0;

        for (const el of candidates) {
          if (out.length >= limit) break;

          // Skip content removed from the accessibility tree.
          if (el.closest('[aria-hidden="true"]')) continue;

          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          const visible =
            rect.width >= minPx &&
            rect.height >= minPx &&
            style.visibility !== 'hidden' &&
            style.display !== 'none';
          if (!visible) continue;

          const alt = el.hasAttribute('alt') ? el.getAttribute('alt') : null;
          const ariaLabel = el.getAttribute('aria-label') ?? undefined;
          const labelledby = el.getAttribute('aria-labelledby');
          let ariaLabelledbyText: string | undefined;
          if (labelledby) {
            ariaLabelledbyText = labelledby
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent?.trim())
              .filter(Boolean)
              .join(' ');
          }
          const title = el.getAttribute('title') ?? undefined;
          const role = el.getAttribute('role') ?? undefined;

          const descriptor = {
            role,
            alt,
            ariaLabel,
            ariaLabelledbyText,
            title,
          };
          const hasAltAttr = descriptor.alt !== null;
          const hasAria = !!ariaLabel?.trim() || !!ariaLabelledbyText?.trim();
          const declaredDecorative = role === 'presentation' || role === 'none';
          const needsReview =
            hasAltAttr || hasAria || !!title?.trim() || declaredDecorative;
          if (!needsReview) continue; // axe owns missing names

          const auditId = `mfa-${counter++}`;
          el.setAttribute('data-mfa-audit-id', auditId);

          const figure = el.closest('figure');
          const figcaption =
            figure?.querySelector('figcaption')?.textContent?.trim() ||
            undefined;
          const surroundingText = el.parentElement?.textContent
            ?.replace(/\s+/g, ' ')
            .trim()
            .slice(0, 200);
          const src =
            el.getAttribute('src') || el.getAttribute('data-src') || undefined;

          out.push({
            auditId,
            selector: auditId,
            src: src ?? undefined,
            role,
            alt,
            ariaLabel,
            ariaLabelledbyText,
            title,
            figcaption,
            surroundingText,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          });
        }

        return out;
      },
      { limit, minPx: MIN_RENDERED_PX },
    );
  }
}

/** Maps a verdict category to the client-facing severity. */
function severityForVerdict(verdict: string): IssueImpact {
  switch (verdict) {
    case 'inaccurate':
    case 'decorative_but_meaningful':
      return IssueImpact.SERIOUS;
    case 'redundant':
      return IssueImpact.MODERATE;
    default:
      return IssueImpact.MINOR;
  }
}

/** Builds the "appropriate" draft (kept so counters/tokens are still tracked). */
function emptyDraft(
  evidence: ImageEvidence,
  usage: { inputTokens: number; outputTokens: number },
): AgentFindingDraft {
  return {
    skill: AgentSkill.IMAGE_ALT_TEXT,
    pageUrl: evidence.pageUrl,
    selector: evidence.selector,
    category: 'appropriate',
    severity: IssueImpact.MINOR,
    confidence: 1,
    message: 'The accessible name appropriately describes the image.',
    usage,
  };
}

const IMAGE_ALT_SYSTEM_PROMPT = `You are a web accessibility expert reviewing the quality of an image's existing accessible name (its alt text, aria-label, aria-labelledby, or title).

Rules:
- A MISSING accessible name is already reported by automated tooling — never flag that; assume a name (or a deliberate empty alt) is present.
- Judge only what you can see in the screenshot and the provided attributes. If the screenshot is missing or you cannot confidently assess the image, return "insufficient_evidence".
- Be conservative and avoid speculation. Prefer "insufficient_evidence" over guessing.

Verdicts:
- "appropriate": the accessible name accurately and concisely conveys the image's meaning (or the image is correctly marked decorative with an empty name).
- "inaccurate": the accessible name does not match what the image actually shows.
- "redundant": the name repeats adjacent visible text or adds noise like "image of"/"picture of".
- "decorative_but_meaningful": the image is marked decorative (empty alt or role=presentation) but actually conveys information that should be described.
- "insufficient_evidence": you cannot reliably judge from the given evidence.

Respond ONLY with the structured object. Keep "rationale" under 60 words. Provide "suggestedAlt" only when proposing a better name.`;

/** Renders the per-image evidence into a compact prompt. */
function buildImagePrompt(evidence: ImageEvidence): string {
  const lines: string[] = [
    `Page: ${evidence.pageUrl}`,
    `Rendered size: ${evidence.width}x${evidence.height}px`,
  ];
  if (evidence.role) lines.push(`role: ${evidence.role}`);
  lines.push(
    `alt attribute: ${evidence.alt === null ? '(absent)' : JSON.stringify(evidence.alt)}`,
  );
  if (evidence.ariaLabel) lines.push(`aria-label: ${evidence.ariaLabel}`);
  if (evidence.ariaLabelledbyText)
    lines.push(`aria-labelledby text: ${evidence.ariaLabelledbyText}`);
  if (evidence.title) lines.push(`title: ${evidence.title}`);
  if (evidence.figcaption) lines.push(`figcaption: ${evidence.figcaption}`);
  if (evidence.surroundingText)
    lines.push(`surrounding text: ${evidence.surroundingText}`);
  if (!evidence.screenshot)
    lines.push('(no screenshot available — judge conservatively)');
  return lines.join('\n');
}
