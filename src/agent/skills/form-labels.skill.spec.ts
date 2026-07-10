import { z } from 'zod';
import {
  FormLabelsSkill,
  FormEvidence,
  formLabelsSchema,
  buildFormPrompt,
} from './form-labels.skill';
import { IssueImpact } from '../../enums/issue-impact.enum';
import type { AgentHarnessService } from '../harness/agent-harness.service';

const baseEvidence = (overrides: Partial<FormEvidence> = {}): FormEvidence => ({
  pageUrl: 'https://example.com',
  fields: [
    {
      id: 'I1',
      selector: 'form > input:nth-of-type(1)',
      controlType: 'date',
      name: 'Start',
      nameSource: 'label',
      constraints: 'inputmode=numeric',
    },
    {
      id: 'I2',
      selector: '#pw',
      controlType: 'password',
      name: 'Password',
      nameSource: 'label',
      constraints: 'pattern=(?=.*[A-Z]).+',
    },
    {
      id: 'I3',
      selector: '#v1',
      controlType: 'text',
      name: 'Value',
      nameSource: 'label',
    },
    {
      id: 'I4',
      selector: '#cc',
      controlType: 'text',
      name: 'Coupon code',
      nameSource: 'label',
      describedby: '8 letters, e.g. ACME2024.',
    },
  ],
  ...overrides,
});

const harnessReturning = (result: unknown): AgentHarnessService =>
  ({
    evaluateStructured: jest.fn().mockResolvedValue({
      data: result,
      usage: { inputTokens: 110, outputTokens: 35 },
      model: 'gpt-4.1-mini',
      degraded: false,
    }),
  }) as unknown as AgentHarnessService;

describe('formLabelsSchema (OpenAI strict compatibility)', () => {
  it('marks every property required (no optional fields)', () => {
    const json = z.toJSONSchema(formLabelsSchema) as {
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

describe('buildFormPrompt', () => {
  it('renders each field with its type, constraints, and described-by text', () => {
    const prompt = buildFormPrompt(baseEvidence());
    expect(prompt).toContain('[I1]');
    expect(prompt).toContain('type=date');
    expect(prompt).toContain('[inputmode=numeric]');
    // Existing instructions are shown so the model does not re-flag them.
    expect(prompt).toContain('desc:"8 letters, e.g. ACME2024."');
    // Scope is stated in the prompt: only 2.4.6 and 3.3.2.
    expect(prompt).toContain('2.4.6');
    expect(prompt).toContain('3.3.2');
  });
});

describe('FormLabelsSkill.evaluate', () => {
  const skill = new FormLabelsSkill();

  it('returns a single appropriate draft (with usage) when no problems', async () => {
    const drafts = await skill.evaluate(
      baseEvidence(),
      harnessReturning({ findings: [] }),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].category).toBe('appropriate');
    expect(drafts[0].usage).toEqual({ inputTokens: 110, outputTokens: 35 });
  });

  it('maps each verdict to category, severity, and WCAG criterion', async () => {
    const drafts = await skill.evaluate(
      baseEvidence(),
      harnessReturning({
        findings: [
          {
            id: 'I2',
            verdict: 'missing_instructions',
            confidence: 0.9,
            rationale: 'Password rules are never stated to the user.',
            suggestedText: 'Must include an uppercase letter.',
          },
          {
            id: 'I3',
            verdict: 'label_not_descriptive',
            confidence: 0.85,
            rationale: '"Value" is ambiguous about the field purpose.',
            suggestedText: 'Discount amount',
          },
        ],
      }),
    );

    expect(drafts).toHaveLength(2);

    const instructions = drafts[0];
    expect(instructions.category).toBe('missing_instructions');
    expect(instructions.severity).toBe(IssueImpact.SERIOUS);
    expect(instructions.wcag).toBe('3.3.2');
    expect(instructions.selector).toBe('#pw');
    expect(instructions.suggestion).toBe('Must include an uppercase letter.');
    expect(instructions.details).toMatchObject({ controlType: 'password' });

    const label = drafts[1];
    expect(label.category).toBe('label_not_descriptive');
    expect(label.severity).toBe(IssueImpact.MODERATE);
    expect(label.wcag).toBe('2.4.6');
    // The model's id resolves back to the real CSS selector for the client.
    expect(label.selector).toBe('#v1');
  });

  it('attributes the request usage to the first draft only', async () => {
    const drafts = await skill.evaluate(
      baseEvidence(),
      harnessReturning({
        findings: [
          {
            id: 'I1',
            verdict: 'missing_instructions',
            confidence: 0.9,
            rationale: 'Date format unstated.',
            suggestedText: null,
          },
          {
            id: 'I3',
            verdict: 'label_not_descriptive',
            confidence: 0.8,
            rationale: 'vague',
            suggestedText: null,
          },
        ],
      }),
    );

    expect(drafts[0].usage).toEqual({ inputTokens: 110, outputTokens: 35 });
    expect(drafts[1].usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('downgrades a low-confidence problem to human review', async () => {
    const [draft] = await skill.evaluate(
      baseEvidence(),
      harnessReturning({
        findings: [
          {
            id: 'I3',
            verdict: 'label_not_descriptive',
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
    expect(draft.wcag).toBe('2.4.6');
    expect(draft.details).toMatchObject({ verdict: 'label_not_descriptive' });
  });

  it('drops an id the model invented, falling back to page-level', async () => {
    const [draft] = await skill.evaluate(
      baseEvidence(),
      harnessReturning({
        findings: [
          {
            id: 'nope',
            verdict: 'missing_instructions',
            confidence: 0.9,
            rationale: 'no instructions',
            suggestedText: null,
          },
        ],
      }),
    );
    expect(draft.selector).toBeUndefined();
    expect(draft.category).toBe('missing_instructions');
    expect(draft.details).toMatchObject({ controlType: null });
  });

  it('ignores model-emitted "appropriate" items among findings', async () => {
    const drafts = await skill.evaluate(
      baseEvidence(),
      harnessReturning({
        findings: [
          {
            id: 'I4',
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
