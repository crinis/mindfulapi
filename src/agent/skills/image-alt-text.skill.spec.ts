import { z } from 'zod';
import {
  ImageAltTextSkill,
  ImageEvidence,
  imageAltVerdictSchema,
  imageNeedsAgentReview,
  isCoveredByAxeAltRule,
} from './image-alt-text.skill';
import { IssueImpact } from '../../enums/issue-impact.enum';
import type { ScannedIssue } from '../../services/axe-accessibility-scanner.service';
import type { AgentHarnessService } from '../harness/agent-harness.service';
import type { CollectContext } from './audit-skill.interface';
import type { Page } from 'playwright';

const baseEvidence = (
  overrides: Partial<ImageEvidence> = {},
): ImageEvidence => ({
  auditId: 'mfa-0',
  selector: 'main > figure > img',
  pageUrl: 'https://example.com',
  src: 'https://example.com/hero.png',
  alt: 'A hero image',
  width: 400,
  height: 300,
  screenshot: Buffer.from('png-bytes'),
  screenshotMediaType: 'image/png',
  ...overrides,
});

const harnessReturning = (verdict: unknown): AgentHarnessService =>
  ({
    evaluateStructured: jest.fn().mockResolvedValue({
      data: verdict,
      usage: { inputTokens: 100, outputTokens: 20 },
    }),
  }) as unknown as AgentHarnessService;

describe('imageAltVerdictSchema (OpenAI strict compatibility)', () => {
  // OpenAI's strict structured-output mode rejects any schema whose `required`
  // array omits a property; a `.optional()` field (vs `.nullable()`) reintroduces
  // that break and silently degrades every request to insufficient_evidence.
  it('marks every property required (no optional fields)', () => {
    const json = z.toJSONSchema(imageAltVerdictSchema) as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(new Set(json.required)).toEqual(
      new Set(Object.keys(json.properties)),
    );
  });
});

describe('imageAltVerdictSchema (no size caps)', () => {
  // A length cap in the schema rejects the whole answer on one overshoot;
  // persistence truncates the text instead.
  it('accepts a long rationale and suggestion', () => {
    expect(
      imageAltVerdictSchema.safeParse({
        verdict: 'inaccurate',
        confidence: 0.9,
        rationale: 'r'.repeat(1000),
        suggestedAlt: 's'.repeat(1000),
      }).success,
    ).toBe(true);
  });
});

describe('imageNeedsAgentReview (trigger)', () => {
  it('includes images with an alt attribute (even empty/decorative)', () => {
    expect(imageNeedsAgentReview({ alt: '' })).toBe(true);
    expect(imageNeedsAgentReview({ alt: 'A cat' })).toBe(true);
  });

  it('includes images named via aria, title, or role=presentation', () => {
    expect(imageNeedsAgentReview({ alt: null, ariaLabel: 'Logo' })).toBe(true);
    expect(
      imageNeedsAgentReview({ alt: null, ariaLabelledbyText: 'Company' }),
    ).toBe(true);
    expect(imageNeedsAgentReview({ alt: null, title: 'Chart' })).toBe(true);
    expect(imageNeedsAgentReview({ alt: null, role: 'presentation' })).toBe(
      true,
    );
  });

  it('excludes images with no name at all (axe owns missing alt)', () => {
    expect(imageNeedsAgentReview({ alt: null })).toBe(false);
    expect(imageNeedsAgentReview({ alt: null, ariaLabel: '   ' })).toBe(false);
  });
});

describe('isCoveredByAxeAltRule', () => {
  const issues: ScannedIssue[] = [
    {
      ruleId: 'image-alt',
      description: 'Images must have alternate text',
      impact: IssueImpact.CRITICAL,
      pageUrl: 'https://example.com',
      context: '<img src="https://example.com/missing.png">',
    },
    {
      ruleId: 'color-contrast',
      description: 'contrast',
      impact: IssueImpact.SERIOUS,
      pageUrl: 'https://example.com',
      context: '<img src="https://example.com/hero.png">',
    },
  ];

  it('matches an image flagged by an axe alt rule', () => {
    expect(
      isCoveredByAxeAltRule('https://example.com/missing.png', issues),
    ).toBe(true);
  });

  it('ignores images only present under non-alt rules', () => {
    expect(isCoveredByAxeAltRule('https://example.com/hero.png', issues)).toBe(
      false,
    );
  });

  it('returns false for missing src', () => {
    expect(isCoveredByAxeAltRule(undefined, issues)).toBe(false);
  });
});

describe('ImageAltTextSkill.collect within a time budget', () => {
  const skill = new ImageAltTextSkill();
  const descriptor = (index: number) => ({
    auditId: `mfa-${index}`,
    selector: `main > img:nth-of-type(${index + 1})`,
    alt: `Photo ${index}`,
    width: 100,
    height: 100,
  });
  const context = (deadline: number): CollectContext => ({
    pageUrl: 'https://example.com',
    axeIssues: [],
    remainingUnits: 30,
    maxUnitsPerPage: 30,
    maxImageBytes: 1_500_000,
    deadline,
  });

  let now: number;
  beforeEach(() => {
    now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => jest.restoreAllMocks());

  /** A page with three candidate images whose screenshots run `shoot`. */
  const pageShooting = (
    shoot: (options: { timeout: number }) => Promise<Buffer>,
  ): { page: Page; options: Array<Record<string, unknown>> } => {
    const options: Array<Record<string, unknown>> = [];
    const page = {
      evaluate: jest.fn().mockResolvedValue([0, 1, 2].map(descriptor)),
      locator: () => ({
        screenshot: (screenshotOptions: { timeout: number }) => {
          options.push(screenshotOptions);
          return shoot(screenshotOptions);
        },
      }),
    } as unknown as Page;
    return { page, options };
  };

  it('stops taking screenshots once the evidence deadline is reached', async () => {
    const { page, options } = pageShooting(() => {
      now += 2000;
      return Promise.resolve(Buffer.from('png'));
    });

    const evidence = await skill.collect(page, context(now + 3000));

    expect(evidence.map((item) => item.alt)).toEqual(['Photo 0', 'Photo 1']);
    // No screenshot may wait past the deadline.
    expect(options.map((option) => option.timeout)).toEqual([2750, 750]);
  });

  it('drops an image whose screenshot ran out of time', async () => {
    const { page } = pageShooting(({ timeout }) => {
      now += timeout;
      return now >= 1_000_000 + 1000
        ? Promise.reject(new Error(`Timeout ${timeout}ms exceeded.`))
        : Promise.resolve(Buffer.from('png'));
    });

    const evidence = await skill.collect(page, context(now + 3000));

    // The first shot used up the budget and failed: nothing to judge.
    expect(evidence).toEqual([]);
  });

  it('freezes CSS animations so an animated image can be captured', async () => {
    const { page, options } = pageShooting(() =>
      Promise.resolve(Buffer.from('png')),
    );

    await skill.collect(page, context(now + 60_000));

    expect(options[0]).toMatchObject({ animations: 'disabled' });
  });
});

describe('ImageAltTextSkill.evaluate', () => {
  const skill = new ImageAltTextSkill();

  it('returns no problem finding for an appropriate name', async () => {
    const [draft] = await skill.evaluate(
      baseEvidence(),
      harnessReturning({
        verdict: 'appropriate',
        confidence: 0.9,
        rationale: 'ok',
      }),
    );
    expect(draft?.category).toBe('appropriate');
  });

  it('maps a confident problem verdict to the right category/severity', async () => {
    const [draft] = await skill.evaluate(
      baseEvidence(),
      harnessReturning({
        verdict: 'inaccurate',
        confidence: 0.9,
        rationale: 'Shows a dog, not a cat',
        suggestedAlt: 'A dog',
      }),
    );
    expect(draft?.category).toBe('inaccurate');
    expect(draft?.severity).toBe(IssueImpact.SERIOUS);
    expect(draft?.suggestion).toBe('A dog');
    expect(draft?.wcag).toBe('1.1.1');
    expect(draft?.needsHumanReview).toBe(false);
  });

  it('records only the media type of an inline data: image source', async () => {
    const [draft] = await skill.evaluate(
      baseEvidence({ src: `data:image/svg+xml;base64,${'A'.repeat(480)}` }),
      harnessReturning({
        verdict: 'redundant',
        confidence: 0.9,
        rationale: 'Repeats the caption.',
        suggestedAlt: null,
      }),
    );
    expect(draft?.details).toMatchObject({ src: 'data:image/svg+xml;…' });
  });

  it('locates the finding by CSS selector and records the image source', async () => {
    const [draft] = await skill.evaluate(
      baseEvidence(),
      harnessReturning({
        verdict: 'redundant',
        confidence: 0.9,
        rationale: 'Repeats the caption.',
        suggestedAlt: null,
      }),
    );
    expect(draft?.selector).toBe('main > figure > img');
    expect(draft?.details).toMatchObject({
      src: 'https://example.com/hero.png',
      currentAlt: 'A hero image',
    });
  });

  it('maps redundant to moderate severity', async () => {
    const [draft] = await skill.evaluate(
      baseEvidence(),
      harnessReturning({
        verdict: 'redundant',
        confidence: 0.8,
        rationale: 'dup',
      }),
    );
    expect(draft?.category).toBe('redundant');
    expect(draft?.severity).toBe(IssueImpact.MODERATE);
  });

  it('downgrades a low-confidence problem to human review', async () => {
    const [draft] = await skill.evaluate(
      baseEvidence(),
      harnessReturning({
        verdict: 'inaccurate',
        confidence: 0.3,
        rationale: 'unsure',
      }),
    );
    expect(draft?.category).toBe('insufficient_evidence');
    expect(draft?.severity).toBe(IssueImpact.MINOR);
    expect(draft?.needsHumanReview).toBe(true);
    expect(draft?.details).toMatchObject({ verdict: 'inaccurate' });
  });

  it('surfaces insufficient_evidence as a human-review finding', async () => {
    const [draft] = await skill.evaluate(
      baseEvidence(),
      harnessReturning({
        verdict: 'insufficient_evidence',
        confidence: 0,
        rationale: 'no screenshot',
      }),
    );
    expect(draft?.category).toBe('insufficient_evidence');
    expect(draft?.needsHumanReview).toBe(true);
  });
});
