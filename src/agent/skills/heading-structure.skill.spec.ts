import { z } from 'zod';
import {
  HeadingStructureSkill,
  HeadingEvidence,
  headingStructureSchema,
  buildHeadingPrompt,
} from './heading-structure.skill';
import { IssueImpact } from '../../enums/issue-impact.enum';
import type { AgentHarnessService } from '../harness/agent-harness.service';

const baseEvidence = (
  overrides: Partial<HeadingEvidence> = {},
): HeadingEvidence => ({
  pageUrl: 'https://example.com',
  pageTitle: 'Acme Pricing',
  headings: [
    {
      id: 'H1',
      selector: 'main > h1',
      level: 1,
      tag: 'h1',
      text: 'Welcome',
      landmark: 'main',
      snippet: 'Our pricing plans start at $9/month.',
    },
    {
      id: 'H2',
      selector: 'main > h2:nth-of-type(1)',
      level: 2,
      tag: 'h2',
      text: 'More',
      landmark: 'main',
      snippet: 'Enterprise features and support options.',
    },
  ],
  fakeHeadingCandidates: [
    {
      id: 'F1',
      selector: 'main > p:nth-of-type(3)',
      text: 'Our Services',
      fontSizePx: 24,
      fontWeight: 700,
    },
  ],
  unheadedSections: [
    {
      id: 'S1',
      selector: 'section:nth-of-type(2)',
      snippet: 'A long run of content with no heading...',
      textLength: 900,
    },
  ],
  ...overrides,
});

const harnessReturning = (result: unknown): AgentHarnessService =>
  ({
    evaluateStructured: jest.fn().mockResolvedValue({
      data: result,
      usage: { inputTokens: 120, outputTokens: 40 },
      model: 'gpt-4.1-mini',
      degraded: false,
    }),
  }) as unknown as AgentHarnessService;

describe('headingStructureSchema (OpenAI strict compatibility)', () => {
  it('marks every property required (no optional fields)', () => {
    const json = z.toJSONSchema(headingStructureSchema) as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(new Set(json.required)).toEqual(
      new Set(Object.keys(json.properties)),
    );
    const item = (
      json.properties.findings as {
        items: { properties: object; required?: string[] };
      }
    ).items;
    expect(new Set(item.required)).toEqual(
      new Set(Object.keys(item.properties)),
    );
  });
});

describe('buildHeadingPrompt', () => {
  it('renders outline, fake-heading, and unheaded-section sections', () => {
    const prompt = buildHeadingPrompt(baseEvidence());
    expect(prompt).toContain('Acme Pricing');
    // The prompt shows short ids, not CSS selectors, so the model never has to
    // reproduce a selector.
    expect(prompt).toContain('[H1]');
    expect(prompt).not.toContain('main > h1');
    expect(prompt).toContain('may be unmarked headings');
    expect(prompt).toContain('WCAG 2.4.10 candidates');
  });
});

describe('HeadingStructureSkill.evaluate', () => {
  const skill = new HeadingStructureSkill();

  it('returns a single appropriate draft (with usage) when no problems', async () => {
    const drafts = await skill.evaluate(
      baseEvidence(),
      harnessReturning({ findings: [] }),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].category).toBe('appropriate');
    expect(drafts[0].usage).toEqual({ inputTokens: 120, outputTokens: 40 });
  });

  it('maps each verdict to category, severity, and WCAG criterion', async () => {
    const drafts = await skill.evaluate(
      baseEvidence(),
      harnessReturning({
        findings: [
          {
            id: 'H2',
            verdict: 'vague_or_generic',
            confidence: 0.9,
            rationale: '"More" is not descriptive.',
            suggestedText: 'Enterprise plans',
            suggestedLevel: null,
          },
          {
            id: 'F1',
            verdict: 'fake_heading',
            confidence: 0.8,
            rationale: 'Styled paragraph acting as a heading.',
            suggestedText: null,
            suggestedLevel: 2,
          },
          {
            id: 'S1',
            verdict: 'missing_section_heading',
            confidence: 0.7,
            rationale: 'Section has substantial content but no heading.',
            suggestedText: 'Support',
            suggestedLevel: 2,
          },
        ],
      }),
    );

    expect(drafts).toHaveLength(3);

    const vague = drafts[0];
    expect(vague.category).toBe('vague_or_generic');
    expect(vague.severity).toBe(IssueImpact.MODERATE);
    expect(vague.suggestion).toBe('Enterprise plans');
    expect(vague.wcag).toBe('2.4.6');
    // The model's id is mapped back to the real CSS selector for the client.
    expect(vague.selector).toBe('main > h2:nth-of-type(1)');

    const fake = drafts[1];
    expect(fake.category).toBe('fake_heading');
    expect(fake.severity).toBe(IssueImpact.SERIOUS);
    expect(fake.wcag).toBe('1.3.1');
    expect(fake.details).toMatchObject({ suggestedLevel: 2 });

    const section = drafts[2];
    expect(section.category).toBe('missing_section_heading');
    expect(section.wcag).toBe('2.4.10');
  });

  it('attributes the request usage to the first draft only', async () => {
    const drafts = await skill.evaluate(
      baseEvidence(),
      harnessReturning({
        findings: [
          {
            id: 'H1',
            verdict: 'h1_topic_mismatch',
            confidence: 0.9,
            rationale: 'h1 says Welcome but the page is about pricing.',
            suggestedText: 'Acme Pricing',
            suggestedLevel: null,
          },
          {
            id: 'H2',
            verdict: 'vague_or_generic',
            confidence: 0.8,
            rationale: 'vague',
            suggestedText: null,
            suggestedLevel: null,
          },
        ],
      }),
    );

    expect(drafts[0].usage).toEqual({ inputTokens: 120, outputTokens: 40 });
    expect(drafts[1].usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('downgrades a low-confidence problem to human review', async () => {
    const [draft] = await skill.evaluate(
      baseEvidence(),
      harnessReturning({
        findings: [
          {
            id: 'H1',
            verdict: 'mis_nested',
            confidence: 0.3,
            rationale: 'maybe wrong level',
            suggestedText: null,
            suggestedLevel: 3,
          },
        ],
      }),
    );
    expect(draft.category).toBe('insufficient_evidence');
    expect(draft.severity).toBe(IssueImpact.MINOR);
    expect(draft.needsHumanReview).toBe(true);
    // The originally judged criterion is still recorded on a downgrade.
    expect(draft.wcag).toBe('1.3.1');
    expect(draft.details).toMatchObject({ verdict: 'mis_nested' });
  });

  it('drops a selector the model invented, falling back to page-level', async () => {
    const [draft] = await skill.evaluate(
      baseEvidence(),
      harnessReturning({
        findings: [
          {
            id: 'nope',
            verdict: 'duplicate',
            confidence: 0.9,
            rationale: 'dup',
            suggestedText: null,
            suggestedLevel: null,
          },
        ],
      }),
    );
    expect(draft.selector).toBeUndefined();
    expect(draft.category).toBe('duplicate');
  });

  it('ignores model-emitted "appropriate" items among findings', async () => {
    const drafts = await skill.evaluate(
      baseEvidence(),
      harnessReturning({
        findings: [
          {
            id: 'H1',
            verdict: 'appropriate',
            confidence: 1,
            rationale: 'fine',
            suggestedText: null,
            suggestedLevel: null,
          },
        ],
      }),
    );
    // All findings were "appropriate" → collapses to the single bookkeeping draft.
    expect(drafts).toHaveLength(1);
    expect(drafts[0].category).toBe('appropriate');
  });
});
