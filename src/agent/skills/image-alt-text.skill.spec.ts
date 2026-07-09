import {
  ImageAltTextSkill,
  ImageEvidence,
  imageNeedsAgentReview,
  isCoveredByAxeAltRule,
} from './image-alt-text.skill';
import { IssueImpact } from '../../enums/issue-impact.enum';
import type { ScannedIssue } from '../../services/axe-accessibility-scanner.service';
import type { AgentHarnessService } from '../harness/agent-harness.service';

const baseEvidence = (
  overrides: Partial<ImageEvidence> = {},
): ImageEvidence => ({
  auditId: 'mfa-0',
  selector: 'mfa-0',
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
      degraded: false,
    }),
  }) as unknown as AgentHarnessService;

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

describe('ImageAltTextSkill.evaluate', () => {
  const skill = new ImageAltTextSkill();

  it('returns no problem finding for an appropriate name', async () => {
    const draft = await skill.evaluate(
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
    const draft = await skill.evaluate(
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
    expect(draft?.details).toMatchObject({ needsHumanReview: false });
  });

  it('maps redundant to moderate severity', async () => {
    const draft = await skill.evaluate(
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
    const draft = await skill.evaluate(
      baseEvidence(),
      harnessReturning({
        verdict: 'inaccurate',
        confidence: 0.3,
        rationale: 'unsure',
      }),
    );
    expect(draft?.category).toBe('insufficient_evidence');
    expect(draft?.severity).toBe(IssueImpact.MINOR);
    expect(draft?.details).toMatchObject({
      verdict: 'inaccurate',
      needsHumanReview: true,
    });
  });

  it('surfaces insufficient_evidence as a human-review finding', async () => {
    const draft = await skill.evaluate(
      baseEvidence(),
      harnessReturning({
        verdict: 'insufficient_evidence',
        confidence: 0,
        rationale: 'no screenshot',
      }),
    );
    expect(draft?.category).toBe('insufficient_evidence');
    expect(draft?.details).toMatchObject({ needsHumanReview: true });
  });
});
