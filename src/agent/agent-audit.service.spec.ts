import { AgentAuditService } from './agent-audit.service';
import { agentConfig } from '../config/configuration';
import { AgentSkill } from '../enums/agent-skill.enum';
import { IssueImpact } from '../enums/issue-impact.enum';
import { Scan } from '../entities/scan.entity';
import type { SkillRegistry } from './skills/skill-registry';
import type { AgentHarnessService } from './harness/agent-harness.service';
import type {
  AgentFindingDraft,
  AuditSkill,
} from './skills/audit-skill.interface';

type AgentSettings = ReturnType<typeof agentConfig>;

const settings = (overrides: Partial<AgentSettings> = {}): AgentSettings => ({
  ...agentConfig(),
  enabled: true,
  allowedSkills: ['image_alt_text'],
  concurrency: 2,
  ...overrides,
});

const makeService = (overrides: Partial<AgentSettings> = {}) => {
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
  const harness = {} as AgentHarnessService;
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
  ({ id: 1, aiAuditSkills: skills }) as Scan;

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
      evaluate: jest.fn().mockResolvedValue(problemDraft()),
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
      evaluate: jest.fn().mockResolvedValue({
        ...problemDraft(),
        category: 'appropriate',
      }),
    } as unknown as AuditSkill;

    await service.evaluate({ id: 1 } as Scan, [{ skill, evidence }], () =>
      Promise.resolve(false),
    );

    expect(findingRepository.save).not.toHaveBeenCalled();
  });

  it('is a no-op with no units', async () => {
    const { service, scanRepository } = makeService();
    await service.evaluate({ id: 1 } as Scan, [], () => Promise.resolve(false));
    expect(scanRepository.update).not.toHaveBeenCalled();
  });

  it('stops evaluating once cancellation is observed', async () => {
    const { service, findingRepository } = makeService({ concurrency: 1 });
    const evaluate = jest.fn().mockResolvedValue(problemDraft());
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
