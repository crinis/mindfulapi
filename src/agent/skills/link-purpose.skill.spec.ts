import { z } from 'zod';
import {
  LinkPurposeSkill,
  LinkEvidence,
  linkPurposeSchema,
  buildLinkPrompt,
} from './link-purpose.skill';
import { IssueImpact } from '../../enums/issue-impact.enum';
import type { AgentHarnessService } from '../harness/agent-harness.service';

const baseEvidence = (overrides: Partial<LinkEvidence> = {}): LinkEvidence => ({
  pageUrl: 'https://example.com',
  links: [
    {
      id: 'L1',
      selector: 'main > p:nth-of-type(1) > a',
      text: 'read more',
      nameSource: 'text',
      destination: 'example.com/blog/accessibility-guide',
      context: 'Our latest guide covers ARIA basics. read more',
      landmark: 'main',
      count: 1,
    },
    {
      id: 'L2',
      selector: 'main > ul > li:nth-of-type(2) > a',
      text: 'https://example.com/pricing',
      nameSource: 'text',
      destination: 'example.com/pricing',
      landmark: 'main',
      count: 1,
    },
    {
      id: 'L3',
      selector: 'nav > a:nth-of-type(1)',
      text: 'Pricing',
      nameSource: 'text',
      destination: 'example.com/pricing',
      landmark: 'navigation',
      count: 3,
    },
  ],
  ...overrides,
});

const harnessReturning = (result: unknown): AgentHarnessService =>
  ({
    evaluateStructured: jest.fn().mockResolvedValue({
      data: result,
      usage: { inputTokens: 90, outputTokens: 30 },
      model: 'gpt-4.1-nano',
      degraded: false,
    }),
  }) as unknown as AgentHarnessService;

describe('linkPurposeSchema (OpenAI strict compatibility)', () => {
  it('marks every property required (no optional fields)', () => {
    const json = z.toJSONSchema(linkPurposeSchema) as {
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

describe('buildLinkPrompt', () => {
  it('renders each link with name, destination, and collapsed repeat count', () => {
    const prompt = buildLinkPrompt(baseEvidence());
    expect(prompt).toContain('https://example.com');
    expect(prompt).toContain('read more');
    expect(prompt).toContain('→ example.com/pricing');
    // The nav link repeated three times is collapsed to one line marked ×3.
    expect(prompt).toContain('(×3)');
    expect(prompt).toContain('context: Our latest guide');
  });

  it('marks links with no href', () => {
    const prompt = buildLinkPrompt(
      baseEvidence({
        links: [
          {
            id: 'L1',
            selector: '[role="link"]',
            text: 'Toggle',
            nameSource: 'text',
            count: 1,
          },
        ],
      }),
    );
    expect(prompt).toContain('(no href)');
  });
});

describe('LinkPurposeSkill.evaluate', () => {
  const skill = new LinkPurposeSkill();

  it('returns a single appropriate draft (with usage) when no problems', async () => {
    const drafts = await skill.evaluate(
      baseEvidence(),
      harnessReturning({ findings: [] }),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].category).toBe('appropriate');
    expect(drafts[0].usage).toEqual({ inputTokens: 90, outputTokens: 30 });
  });

  it('maps each verdict to category, severity, and WCAG criterion', async () => {
    const drafts = await skill.evaluate(
      baseEvidence(),
      harnessReturning({
        findings: [
          {
            id: 'L1',
            verdict: 'unclear_without_context',
            confidence: 0.8,
            rationale: '"read more" only makes sense next to the guide title.',
            suggestedText: 'Read the accessibility guide',
          },
          {
            id: 'L2',
            verdict: 'url_as_text',
            confidence: 0.9,
            rationale: 'The visible text is a raw URL.',
            suggestedText: 'Pricing',
          },
        ],
      }),
    );

    expect(drafts).toHaveLength(2);

    const unclear = drafts[0];
    expect(unclear.category).toBe('unclear_without_context');
    expect(unclear.severity).toBe(IssueImpact.MODERATE);
    expect(unclear.wcag).toBe('2.4.9');
    // The model's id is mapped back to the real CSS selector for the client.
    expect(unclear.selector).toBe('main > p:nth-of-type(1) > a');
    expect(unclear.suggestion).toBe('Read the accessibility guide');
    expect(unclear.details).toMatchObject({ linkText: 'read more' });

    const url = drafts[1];
    expect(url.category).toBe('url_as_text');
    expect(url.severity).toBe(IssueImpact.SERIOUS);
    expect(url.wcag).toBe('2.4.4');
  });

  it('attributes the request usage to the first draft only', async () => {
    const drafts = await skill.evaluate(
      baseEvidence(),
      harnessReturning({
        findings: [
          {
            id: 'L1',
            verdict: 'vague_or_generic',
            confidence: 0.9,
            rationale: 'vague',
            suggestedText: null,
          },
          {
            id: 'L2',
            verdict: 'url_as_text',
            confidence: 0.8,
            rationale: 'raw url',
            suggestedText: null,
          },
        ],
      }),
    );

    expect(drafts[0].usage).toEqual({ inputTokens: 90, outputTokens: 30 });
    expect(drafts[1].usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('downgrades a low-confidence problem to human review', async () => {
    const [draft] = await skill.evaluate(
      baseEvidence(),
      harnessReturning({
        findings: [
          {
            id: 'L1',
            verdict: 'not_descriptive',
            confidence: 0.3,
            rationale: 'maybe unclear',
            suggestedText: null,
          },
        ],
      }),
    );
    expect(draft.category).toBe('insufficient_evidence');
    expect(draft.severity).toBe(IssueImpact.MINOR);
    expect(draft.needsHumanReview).toBe(true);
    // The originally judged criterion is still recorded on a downgrade.
    expect(draft.wcag).toBe('2.4.4');
    expect(draft.details).toMatchObject({ verdict: 'not_descriptive' });
  });

  it('drops a selector the model invented, falling back to page-level', async () => {
    const [draft] = await skill.evaluate(
      baseEvidence(),
      harnessReturning({
        findings: [
          {
            id: 'nope',
            verdict: 'vague_or_generic',
            confidence: 0.9,
            rationale: 'vague',
            suggestedText: null,
          },
        ],
      }),
    );
    expect(draft.selector).toBeUndefined();
    expect(draft.category).toBe('vague_or_generic');
    expect(draft.details).toMatchObject({ linkText: null });
  });

  it('ignores model-emitted "appropriate" items among findings', async () => {
    const drafts = await skill.evaluate(
      baseEvidence(),
      harnessReturning({
        findings: [
          {
            id: 'L3',
            verdict: 'appropriate',
            confidence: 1,
            rationale: 'clear',
            suggestedText: null,
          },
        ],
      }),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].category).toBe('appropriate');
  });
});
