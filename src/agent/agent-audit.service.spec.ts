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
import type { Page } from 'playwright';
import type {
  AgentFindingDraft,
  AuditSkill,
  CollectContext,
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

describe('AgentAuditService.collectForPage', () => {
  const page = {} as Page;
  const pageUrl = 'https://example.com';

  /** An element skill that fills whatever budget it is given. */
  const elementSkill = (): AuditSkill =>
    ({
      id: AgentSkill.IMAGE_ALT_TEXT,
      granularity: 'element',
      order: 10,
      collect: jest.fn((_page: Page, ctx: CollectContext) =>
        Promise.resolve(
          Array.from({ length: ctx.maxUnitsPerPage }, (_, i) => ({
            pageUrl,
            selector: `img:nth-of-type(${i + 1})`,
          })),
        ),
      ),
    }) as unknown as AuditSkill;
  /** A page skill that yields its single unit. */
  const pageSkill = (id: AgentSkill, order: number): AuditSkill =>
    ({
      id,
      granularity: 'page',
      order,
      collect: jest.fn(() => Promise.resolve([{ pageUrl }])),
    }) as unknown as AuditSkill;

  it('keeps a unit for each page skill on a page with more images than the cap', async () => {
    const { service } = makeService({ maxUnitsPerPage: 30 });
    const skills = [
      elementSkill(),
      pageSkill(AgentSkill.HEADING_STRUCTURE, 20),
      pageSkill(AgentSkill.PAGE_TITLE, 50),
    ];

    const units = await service.collectForPage(skills, page, pageUrl, [], 0);

    const ids = units.map((unit) => unit.skill.id);
    expect(ids).toContain(AgentSkill.HEADING_STRUCTURE);
    expect(ids).toContain(AgentSkill.PAGE_TITLE);
    expect(units).toHaveLength(30);
    expect(ids.filter((id) => id === AgentSkill.IMAGE_ALT_TEXT)).toHaveLength(
      28,
    );
  });

  it('puts page units first, so the scan-wide clamp drops images first', async () => {
    const { service } = makeService({ maxUnitsPerPage: 30 });
    const skills = [
      elementSkill(),
      pageSkill(AgentSkill.HEADING_STRUCTURE, 20),
    ];

    const units = await service.collectForPage(skills, page, pageUrl, [], 0);

    expect(units[0].skill.id).toBe(AgentSkill.HEADING_STRUCTURE);
  });

  it('gives page skills the scan-wide remainder first', async () => {
    const { service } = makeService({
      maxUnitsPerPage: 30,
      maxUnitsPerScan: 10,
    });
    const image = elementSkill();
    const imageCollect = jest.spyOn(image, 'collect');
    const skills = [
      image,
      pageSkill(AgentSkill.HEADING_STRUCTURE, 20),
      pageSkill(AgentSkill.LINK_PURPOSE, 30),
    ];

    // 9 units already buffered: room for one more in this scan.
    const units = await service.collectForPage(skills, page, pageUrl, [], 9);

    expect(units.map((unit) => unit.skill.id)).toEqual([
      AgentSkill.HEADING_STRUCTURE,
    ]);
    expect(imageCollect).not.toHaveBeenCalled();
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

  it('stops every worker when one of them fails', async () => {
    const { service } = makeService({ concurrency: 4 });
    let evaluated = 0;
    let evaluatedAfterRejection = 0;
    let rejected = false;
    const skill = {
      id: AgentSkill.IMAGE_ALT_TEXT,
      evaluate: jest.fn(async () => {
        evaluated++;
        if (rejected) evaluatedAfterRejection++;
        // A model request: other workers run meanwhile.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [{ ...problemDraft(), category: 'appropriate' }];
      }),
    } as unknown as AuditSkill;
    const units = Array.from({ length: 20 }, () => ({ skill, evidence }));
    // The cancellation check hits a transient database error on its 6th call.
    let checks = 0;
    const isCanceled = (): Promise<boolean> =>
      ++checks === 6
        ? Promise.reject(new Error('SQLITE_BUSY: database is locked'))
        : Promise.resolve(false);

    await expect(
      service.evaluate({ id: 1 } as Scan, units, isCanceled),
    ).rejects.toThrow('SQLITE_BUSY');
    rejected = true;
    // Let any worker that was still running reach its next unit.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Five units passed their check before the failing one; each of the
    // three other workers finishes at most the unit it had started.
    expect(evaluated).toBeLessThanOrEqual(5 + 3);
    expect(evaluatedAfterRejection).toBe(0);
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

  it('keeps the first 30 findings of an answer that overshoots the caps', async () => {
    // One finding more than the cap, one rationale longer than the old
    // 400-character limit: either used to reject the whole answer.
    const outline = Array.from({ length: 31 }, (_, i) => ({
      id: `H${i + 1}`,
      selector: `main > h2:nth-of-type(${i + 1})`,
      level: 2,
      tag: 'h2',
      text: 'More',
    }));
    const model = answering({
      findings: outline.map((heading, i) => ({
        id: heading.id,
        verdict: 'vague_or_generic',
        confidence: 0.9,
        rationale: i === 0 ? 'x'.repeat(500) : 'Uninformative heading.',
        suggestedText: null,
        suggestedLevel: null,
      })),
    });
    const { service, findingRepository, scanRepository } = makeService(
      {},
      harnessFor(model),
    );

    const evidence: HeadingEvidence = { ...headingEvidence, headings: outline };

    await service.evaluate(
      { id: 1 } as Scan,
      [{ skill: headingSkill, evidence }],
      () => Promise.resolve(false),
    );

    expect(findingRepository.save).toHaveBeenCalledTimes(30);
    expect(findingRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'x'.repeat(500) }),
    );
    expect(scanRepository.update).toHaveBeenLastCalledWith(1, {
      aiTasksCompleted: 1,
      aiTasksFailed: 0,
    });
  });
});
