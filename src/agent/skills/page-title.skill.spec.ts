import { z } from 'zod';
import {
  PageTitleSkill,
  PageTitleEvidence,
  pageTitleSchema,
  buildTitlePrompt,
} from './page-title.skill';
import { IssueImpact } from '../../enums/issue-impact.enum';
import type { AgentHarnessService } from '../harness/agent-harness.service';

const baseEvidence = (
  overrides: Partial<PageTitleEvidence> = {},
): PageTitleEvidence => ({
  pageUrl: 'https://example.com/widgets/blue',
  title: 'Blue Widget – Specs & Pricing | Acme Corp',
  headings: [
    { level: 1, text: 'Blue Widget' },
    { level: 2, text: 'Technical specifications' },
  ],
  metaDescription: 'Specs and pricing for the Acme Blue Widget.',
  ...overrides,
});

const harnessReturning = (result: unknown): AgentHarnessService =>
  ({
    evaluateStructured: jest.fn().mockResolvedValue({
      data: result,
      usage: { inputTokens: 120, outputTokens: 20 },
      model: 'gpt-4.1-mini',
      degraded: false,
    }),
  }) as unknown as AgentHarnessService;

describe('pageTitleSchema (OpenAI strict compatibility)', () => {
  it('marks every property required (no optional fields)', () => {
    const json = z.toJSONSchema(pageTitleSchema) as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(new Set(json.required)).toEqual(
      new Set(Object.keys(json.properties)),
    );
  });
});

describe('buildTitlePrompt', () => {
  it('renders the title, headings, and meta description', () => {
    const prompt = buildTitlePrompt(baseEvidence());
    expect(prompt).toContain('https://example.com/widgets/blue');
    expect(prompt).toContain('Blue Widget – Specs & Pricing | Acme Corp');
    expect(prompt).toContain('Primary heading (h1): "Blue Widget"');
    expect(prompt).toContain('h2 "Technical specifications"');
    expect(prompt).toContain('Specs and pricing for the Acme Blue Widget.');
  });

  it('marks absent headings and meta description as "none"', () => {
    const prompt = buildTitlePrompt(
      baseEvidence({ headings: [], metaDescription: null }),
    );
    expect(prompt).toContain('Primary heading: none');
    expect(prompt).toContain('Other headings: none');
    expect(prompt).toContain('Meta description: none');
  });
});

describe('PageTitleSkill.evaluate', () => {
  const skill = new PageTitleSkill();

  it('returns a single appropriate draft (with usage) when the title is clear', async () => {
    const drafts = await skill.evaluate(
      baseEvidence(),
      harnessReturning({
        verdict: 'appropriate',
        confidence: 0.95,
        rationale: 'Describes the page and keeps the brand.',
        suggestedTitle: null,
      }),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].category).toBe('appropriate');
    expect(drafts[0].usage).toEqual({ inputTokens: 120, outputTokens: 20 });
  });

  it('maps a boilerplate title to SERIOUS / 2.4.2 with the title selector', async () => {
    const [draft] = await skill.evaluate(
      baseEvidence({ title: 'Untitled Document' }),
      harnessReturning({
        verdict: 'generic_or_boilerplate',
        confidence: 0.95,
        rationale: 'Placeholder title that identifies nothing.',
        suggestedTitle: 'Blue Widget – Specs & Pricing | Acme Corp',
      }),
    );
    expect(draft.category).toBe('generic_or_boilerplate');
    expect(draft.severity).toBe(IssueImpact.SERIOUS);
    expect(draft.wcag).toBe('2.4.2');
    expect(draft.selector).toBe('title');
    expect(draft.suggestion).toBe('Blue Widget – Specs & Pricing | Acme Corp');
    expect(draft.details).toMatchObject({ verdict: 'generic_or_boilerplate' });
  });

  it('maps a non-descriptive title to MODERATE / 2.4.2', async () => {
    const [draft] = await skill.evaluate(
      baseEvidence({ title: 'Page 3' }),
      harnessReturning({
        verdict: 'not_descriptive',
        confidence: 0.8,
        rationale: 'Does not convey the page topic.',
        suggestedTitle: null,
      }),
    );
    expect(draft.category).toBe('not_descriptive');
    expect(draft.severity).toBe(IssueImpact.MODERATE);
    expect(draft.wcag).toBe('2.4.2');
  });

  it('downgrades a low-confidence problem to human review', async () => {
    const [draft] = await skill.evaluate(
      baseEvidence(),
      harnessReturning({
        verdict: 'not_descriptive',
        confidence: 0.3,
        rationale: 'maybe unclear',
        suggestedTitle: null,
      }),
    );
    expect(draft.category).toBe('insufficient_evidence');
    expect(draft.severity).toBe(IssueImpact.MINOR);
    expect(draft.needsHumanReview).toBe(true);
    // The originally judged criterion is still recorded on a downgrade.
    expect(draft.wcag).toBe('2.4.2');
    expect(draft.details).toMatchObject({ verdict: 'not_descriptive' });
  });

  it('treats the degraded fallback as a benign appropriate draft', async () => {
    // On generation failure the harness returns the skill's SAFE_RESULT
    // (verdict "appropriate"), which must never surface as a false positive.
    const drafts = await skill.evaluate(
      baseEvidence(),
      harnessReturning({
        verdict: 'appropriate',
        confidence: 0,
        rationale: 'unavailable',
        suggestedTitle: null,
      }),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].category).toBe('appropriate');
  });
});
