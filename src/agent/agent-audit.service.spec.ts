import { MockLanguageModelV4 } from 'ai/test';
import { AgentAuditService } from './agent-audit.service';
import { agentConfig } from '../config/configuration';
import { AgentSkill } from '../enums/agent-skill.enum';
import { IssueImpact } from '../enums/issue-impact.enum';
import { Scan } from '../entities/scan.entity';
import type { SkillRegistry } from './skills/skill-registry';
import { AgentHarnessService } from './harness/agent-harness.service';
import { ModelProviderFactory } from './harness/model-provider.factory';
import {
  ImageAltTextSkill,
  type ImageEvidence,
} from './skills/image-alt-text.skill';
import {
  HeadingStructureSkill,
  type HeadingEvidence,
} from './skills/heading-structure.skill';
import {
  PageTitleSkill,
  type PageTitleEvidence,
} from './skills/page-title.skill';
import type {
  AgentFindingDraft,
  AuditSkill,
} from './skills/audit-skill.interface';
import { ScanMode } from '../enums/scan-mode.enum';

type AgentSettings = ReturnType<typeof agentConfig>;

const settings = (overrides: Partial<AgentSettings> = {}): AgentSettings => ({
  ...agentConfig(),
  enabled: true,
  allowedSkills: ['image_alt_text'],
  allowedScanModes: [ScanMode.SINGLE_URL],
  concurrency: 2,
  ...overrides,
});

const makeService = (
  overrides: Partial<AgentSettings> = {},
  harness: AgentHarnessService = {} as AgentHarnessService,
) => {
  const findingRepository = {
    create: jest.fn((entity: unknown) => entity),
    save: jest.fn().mockResolvedValue(undefined),
    createQueryBuilder: jest.fn(() => ({
      delete: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    })),
  };
  const scanRepository = { update: jest.fn().mockResolvedValue(undefined) };
  const registry = { resolve: jest.fn() };
  const service = new AgentAuditService(
    findingRepository as never,
    scanRepository as never,
    registry as unknown as SkillRegistry,
    harness,
    settings(overrides),
  );
  return { service, findingRepository, scanRepository, registry, harness };
};

const scanWith = (skills: AgentSkill[] | null): Scan =>
  ({ id: 1, mode: ScanMode.SINGLE_URL, aiAuditSkills: skills }) as Scan;

const problemDraft = (): AgentFindingDraft => ({
  skill: AgentSkill.IMAGE_ALT_TEXT,
  pageUrl: 'https://example.com',
  selector: 'img',
  category: 'inaccurate',
  severity: IssueImpact.SERIOUS,
  confidence: 0.9,
  message: 'wrong',
  usage: { inputTokens: 10, outputTokens: 5 },
});

describe('AgentAuditService.resolveSkills', () => {
  it('returns [] when the feature is disabled', () => {
    const { service, registry } = makeService({ enabled: false });
    expect(
      service.resolveSkills(scanWith([AgentSkill.IMAGE_ALT_TEXT])),
    ).toEqual([]);
    expect(registry.resolve).not.toHaveBeenCalled();
  });

  it('returns [] when no skills were requested', () => {
    const { service } = makeService();
    expect(service.resolveSkills(scanWith(null))).toEqual([]);
  });

  it('returns [] when the queued scan mode is no longer allowed', () => {
    const { service, registry } = makeService();
    const scan = {
      ...scanWith([AgentSkill.IMAGE_ALT_TEXT]),
      mode: ScanMode.CRAWL,
    };

    expect(service.resolveSkills(scan)).toEqual([]);
    expect(registry.resolve).not.toHaveBeenCalled();
  });

  it('delegates to the registry with the whitelist when enabled', () => {
    const { service, registry } = makeService();
    registry.resolve.mockReturnValue(['skill']);
    const result = service.resolveSkills(scanWith([AgentSkill.IMAGE_ALT_TEXT]));
    expect(registry.resolve).toHaveBeenCalledWith(
      [AgentSkill.IMAGE_ALT_TEXT],
      ['image_alt_text'],
    );
    expect(result).toEqual(['skill']);
  });
});

describe('AgentAuditService.evaluate', () => {
  const evidence = { pageUrl: 'https://example.com' };

  it('persists problem findings and records counters', async () => {
    const { service, findingRepository, scanRepository } = makeService();
    const skill = {
      id: AgentSkill.IMAGE_ALT_TEXT,
      evaluate: jest.fn().mockResolvedValue([problemDraft()]),
    } as unknown as AuditSkill;

    await service.evaluate({ id: 1 } as Scan, [{ skill, evidence }], () =>
      Promise.resolve(false),
    );

    expect(findingRepository.save).toHaveBeenCalledTimes(1);
    expect(scanRepository.update).toHaveBeenCalledWith(1, {
      aiTasksTotal: 1,
      aiTasksCompleted: 0,
      aiTasksFailed: 0,
    });
    expect(scanRepository.update).toHaveBeenLastCalledWith(1, {
      aiTasksCompleted: 1,
      aiTasksFailed: 0,
    });
  });

  it('counts but does not persist an "appropriate" verdict', async () => {
    const { service, findingRepository } = makeService();
    const skill = {
      id: AgentSkill.IMAGE_ALT_TEXT,
      evaluate: jest.fn().mockResolvedValue([
        {
          ...problemDraft(),
          category: 'appropriate',
        },
      ]),
    } as unknown as AuditSkill;

    await service.evaluate({ id: 1 } as Scan, [{ skill, evidence }], () =>
      Promise.resolve(false),
    );

    expect(findingRepository.save).not.toHaveBeenCalled();
  });

  it('persists every problem draft from a multi-finding page unit', async () => {
    const { service, findingRepository, scanRepository } = makeService();
    // A page-level unit returns several drafts from one request: the first
    // carries the token usage, the rest zero, plus a non-persisted appropriate.
    const skill = {
      id: AgentSkill.IMAGE_ALT_TEXT,
      evaluate: jest.fn().mockResolvedValue([
        { ...problemDraft(), usage: { inputTokens: 40, outputTokens: 12 } },
        {
          ...problemDraft(),
          category: 'vague_or_generic',
          usage: { inputTokens: 0, outputTokens: 0 },
        },
        {
          ...problemDraft(),
          category: 'appropriate',
          usage: { inputTokens: 0, outputTokens: 0 },
        },
      ]),
    } as unknown as AuditSkill;

    await service.evaluate({ id: 1 } as Scan, [{ skill, evidence }], () =>
      Promise.resolve(false),
    );

    // Two problem drafts persisted, the appropriate one skipped; the unit
    // counts as a single completed task despite yielding multiple findings.
    expect(findingRepository.save).toHaveBeenCalledTimes(2);
    expect(scanRepository.update).toHaveBeenLastCalledWith(1, {
      aiTasksCompleted: 1,
      aiTasksFailed: 0,
    });
  });

  it('is a no-op with no units', async () => {
    const { service, scanRepository } = makeService();
    await service.evaluate({ id: 1 } as Scan, [], () => Promise.resolve(false));
    expect(scanRepository.update).not.toHaveBeenCalled();
  });

  it('stops evaluating once cancellation is observed', async () => {
    const { service, findingRepository } = makeService({ concurrency: 1 });
    const evaluate = jest.fn().mockResolvedValue([problemDraft()]);
    const skill = {
      id: AgentSkill.IMAGE_ALT_TEXT,
      evaluate,
    } as unknown as AuditSkill;

    await service.evaluate(
      { id: 1 } as Scan,
      [
        { skill, evidence },
        { skill, evidence },
      ],
      () => Promise.resolve(true), // canceled from the start
    );

    expect(evaluate).not.toHaveBeenCalled();
    expect(findingRepository.save).not.toHaveBeenCalled();
  });
});

/**
 * The real harness and skills, with the provider either unusable or replaced
 * by the AI SDK's mock model — no request leaves the process.
 */
describe('AgentAuditService.evaluate with the real harness', () => {
  const pageUrl = 'https://example.com';
  const imageSkill = new ImageAltTextSkill();
  const titleSkill = new PageTitleSkill();
  const headingSkill = new HeadingStructureSkill();

  const imageEvidence = (index: number): ImageEvidence => ({
    auditId: `mfa-${index}`,
    selector: `main > img:nth-of-type(${index + 1})`,
    pageUrl,
    src: `${pageUrl}/photo-${index}.png`,
    alt: `Photo ${index}`,
    width: 200,
    height: 100,
  });
  const titleEvidence: PageTitleEvidence = {
    pageUrl,
    title: 'Home',
    headings: [{ level: 1, text: 'Pricing plans' }],
    metaDescription: null,
  };
  const headingEvidence: HeadingEvidence = {
    pageUrl,
    pageTitle: 'Pricing',
    headings: [
      { id: 'H1', selector: 'main > h1', level: 1, tag: 'h1', text: 'More' },
    ],
    fakeHeadingCandidates: [],
    unheadedSections: [],
  };

  const usage = {
    inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 10, text: 10, reasoning: 0 },
  };
  /** A mock model that answers every request with `value` as JSON text. */
  const answering = (value: unknown): MockLanguageModelV4 =>
    new MockLanguageModelV4({
      doGenerate: () =>
        Promise.resolve({
          content: [{ type: 'text', text: JSON.stringify(value) }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage,
          warnings: [],
        }),
    });
  /** A harness whose every request goes to `model`. */
  const harnessFor = (model: MockLanguageModelV4): AgentHarnessService =>
    new AgentHarnessService(
      {
        getModel: () => Promise.resolve(model),
        resolveModelConfig: () => ({
          provider: 'openai',
          model: 'mock-model-id',
          apiKey: 'sk-test',
          baseUrl: null,
          reasoningEffort: null,
        }),
      } as unknown as ModelProviderFactory,
      settings(),
    );

  it('counts every unit as failed and stores nothing when the provider cannot be used', async () => {
    // No API key: every request fails before it is sent.
    const noKey: Partial<AgentSettings> = {
      provider: 'openai',
      model: 'gpt-test',
      apiKey: null,
      skillModels: {},
    };
    const harness = new AgentHarnessService(
      new ModelProviderFactory(settings(noKey)),
      settings(noKey),
    );
    const { service, findingRepository, scanRepository } = makeService(
      noKey,
      harness,
    );
    const units = [
      { skill: imageSkill, evidence: imageEvidence(0) },
      { skill: imageSkill, evidence: imageEvidence(1) },
      { skill: titleSkill, evidence: titleEvidence },
      { skill: headingSkill, evidence: headingEvidence },
    ] as unknown as Parameters<AgentAuditService['evaluate']>[1];

    await service.evaluate({ id: 1 } as Scan, units, () =>
      Promise.resolve(false),
    );

    expect(findingRepository.save).not.toHaveBeenCalled();
    expect(scanRepository.update).toHaveBeenLastCalledWith(1, {
      aiTasksCompleted: 0,
      aiTasksFailed: units.length,
    });
  });

  it('counts a unit whose model answer does not match the schema as failed', async () => {
    const model = answering({ verdict: 'looks fine to me' });
    const { service, findingRepository, scanRepository } = makeService(
      {},
      harnessFor(model),
    );

    await service.evaluate(
      { id: 1 } as Scan,
      [{ skill: imageSkill, evidence: imageEvidence(0) }],
      () => Promise.resolve(false),
    );

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(findingRepository.save).not.toHaveBeenCalled();
    expect(scanRepository.update).toHaveBeenLastCalledWith(1, {
      aiTasksCompleted: 0,
      aiTasksFailed: 1,
    });
  });

  it('stores the verdict of a valid model answer', async () => {
    const model = answering({
      verdict: 'redundant',
      confidence: 0.9,
      rationale: 'Repeats the caption.',
      suggestedAlt: null,
    });
    const { service, findingRepository, scanRepository } = makeService(
      {},
      harnessFor(model),
    );

    await service.evaluate(
      { id: 1 } as Scan,
      [{ skill: imageSkill, evidence: imageEvidence(0) }],
      () => Promise.resolve(false),
    );

    expect(findingRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'redundant',
        model: 'mock-model-id',
      }),
    );
    expect(scanRepository.update).toHaveBeenLastCalledWith(1, {
      aiTasksCompleted: 1,
      aiTasksFailed: 0,
    });
  });
});
