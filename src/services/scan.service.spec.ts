import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ScanService } from './scan.service';
import { ScanQueueService } from './scan-queue.service';
import { BasicAuthCryptoService } from './basic-auth-crypto.service';
import { UrlPolicyService } from './url-policy.service';
import { Scan } from '../entities/scan.entity';
import { Issue } from '../entities/issue.entity';
import { AgentFinding } from '../entities/agent-finding.entity';
import { agentConfig } from '../config/configuration';
import { AgentSkill } from '../enums/agent-skill.enum';
import { AiAuditStatus } from '../dto/scan/response/ai-audit-response.dto';
import { ScanStatus } from '../enums/scan-status.enum';
import { IssueImpact } from '../enums/issue-impact.enum';
import {
  CreateSingleUrlScanDto,
  CreateUrlListScanDto,
  CreateCrawlScanDto,
} from '../dto/scan/request';
import { ScanMode } from '../enums/scan-mode.enum';
import { CrawlStrategy } from '../enums/crawl-strategy.enum';

const makeIssue = (overrides: Partial<Issue> = {}): Issue =>
  ({
    id: 1,
    ruleId: 'color-contrast',
    description: 'Elements must have sufficient color contrast',
    impact: IssueImpact.SERIOUS,
    pageUrl: 'https://example.com',
    selector: '.btn',
    context: '<button class="btn">Click</button>',
    helpUrl:
      'https://dequeuniversity.com/rules/axe/4.11/color-contrast?application=playwright',
    ...overrides,
  }) as Issue;

const makeScan = (overrides: Partial<Scan> = {}): Scan => ({
  id: 1,
  mode: ScanMode.SINGLE_URL,
  targets: ['https://example.com'],
  rootElement: undefined,
  ruleIds: null,
  basicAuthUsernameEncrypted: null,
  basicAuthPasswordEncrypted: null,
  crawlMaxPages: null,
  crawlMaxDepth: null,
  crawlStrategy: null,
  crawlGlobs: null,
  crawlExcludeGlobs: null,
  status: ScanStatus.PENDING,
  pagesDiscovered: 0,
  pagesScanned: 0,
  pagesFailed: 0,
  issues: [],
  aiAuditSkills: null,
  aiTasksTotal: 0,
  aiTasksCompleted: 0,
  aiTasksFailed: 0,
  agentFindings: [],
  createdAt: new Date('2025-01-01T00:00:00Z'),
  updatedAt: new Date('2025-01-01T00:00:00Z'),
  ...overrides,
});

describe('ScanService', () => {
  let service: ScanService;
  let mockRepo: jest.Mocked<Record<string, jest.Mock>>;
  let mockIssueRepo: jest.Mocked<Record<string, jest.Mock>>;
  let mockQueue: jest.Mocked<
    Pick<ScanQueueService, 'addScanJob' | 'cancelScanJob'>
  >;
  let mockBasicAuthCrypto: jest.Mocked<
    Pick<BasicAuthCryptoService, 'encryptCredentials'>
  >;
  let mockUrlPolicy: jest.Mocked<
    Pick<UrlPolicyService, 'assertAllowedTargets'>
  >;
  let scanQueryBuilder: {
    orderBy: jest.Mock;
    skip: jest.Mock;
    take: jest.Mock;
    andWhere: jest.Mock;
    getManyAndCount: jest.Mock;
  };
  let issueCountQueryBuilder: {
    select: jest.Mock;
    addSelect: jest.Mock;
    where: jest.Mock;
    groupBy: jest.Mock;
    addGroupBy: jest.Mock;
    getRawMany: jest.Mock;
  };
  let mockAgentFindingRepo: jest.Mocked<Record<string, jest.Mock>>;
  let agentFindingQueryBuilder: {
    select: jest.Mock;
    addSelect: jest.Mock;
    where: jest.Mock;
    groupBy: jest.Mock;
    getRawMany: jest.Mock;
  };

  beforeEach(async () => {
    scanQueryBuilder = {
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    issueCountQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };

    mockRepo = {
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
      delete: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue(scanQueryBuilder),
    };
    mockIssueRepo = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn().mockReturnValue(issueCountQueryBuilder),
    };
    agentFindingQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    mockAgentFindingRepo = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn().mockReturnValue(agentFindingQueryBuilder),
    };

    mockQueue = {
      addScanJob: jest.fn().mockResolvedValue(undefined),
      cancelScanJob: jest.fn().mockResolvedValue(null),
    };
    mockBasicAuthCrypto = {
      encryptCredentials: jest.fn(),
    };
    mockUrlPolicy = {
      assertAllowedTargets: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScanService,
        { provide: getRepositoryToken(Scan), useValue: mockRepo },
        { provide: getRepositoryToken(Issue), useValue: mockIssueRepo },
        {
          provide: getRepositoryToken(AgentFinding),
          useValue: mockAgentFindingRepo,
        },
        { provide: ScanQueueService, useValue: mockQueue },
        { provide: BasicAuthCryptoService, useValue: mockBasicAuthCrypto },
        { provide: UrlPolicyService, useValue: mockUrlPolicy },
        { provide: agentConfig.KEY, useValue: agentConfig() },
      ],
    }).compile();

    service = module.get<ScanService>(ScanService);
  });

  describe('create()', () => {
    it('rejects creation when the URL policy blocks a target', async () => {
      mockUrlPolicy.assertAllowedTargets.mockRejectedValue(
        new BadRequestException('Scan target(s) not allowed'),
      );

      await expect(
        service.create({
          mode: ScanMode.SINGLE_URL,
          url: 'http://127.0.0.1/',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(mockRepo.save).not.toHaveBeenCalled();
      expect(mockQueue.addScanJob).not.toHaveBeenCalled();
    });

    it('saves a single_url scan, queues a job, and returns the created scan', async () => {
      const dto: CreateSingleUrlScanDto = {
        mode: ScanMode.SINGLE_URL,
        url: 'https://example.com',
      };
      const saved = makeScan();

      mockRepo.create.mockReturnValue(saved);
      mockRepo.save.mockResolvedValue(saved);
      mockRepo.findOne.mockResolvedValue({ ...saved, issues: [] });

      const result = await service.create(dto);

      expect(mockRepo.create).toHaveBeenCalledWith({
        mode: ScanMode.SINGLE_URL,
        targets: ['https://example.com/'],
        rootElement: undefined,
        ruleIds: null,
        basicAuthUsernameEncrypted: null,
        basicAuthPasswordEncrypted: null,
        crawlMaxPages: null,
        crawlMaxDepth: null,
        crawlStrategy: null,
        crawlGlobs: null,
        crawlExcludeGlobs: null,
        aiAuditSkills: null,
        status: ScanStatus.PENDING,
      });
      expect(mockRepo.save).toHaveBeenCalledWith(saved);
      expect(mockQueue.addScanJob).toHaveBeenCalledWith(saved.id);
      expect(mockBasicAuthCrypto.encryptCredentials).not.toHaveBeenCalled();
      expect(result.id).toBe(saved.id);
      expect(result.mode).toBe(ScanMode.SINGLE_URL);
      expect(result.targets).toEqual(['https://example.com']);
      expect(result.violations).toEqual([]);
      expect(result.totalIssueCount).toBe(0);
    });

    it('saves a crawl scan with defaults and queues a job', async () => {
      const dto: CreateCrawlScanDto = {
        mode: ScanMode.CRAWL,
        startUrls: ['https://example.com'],
      };
      const saved = makeScan({
        mode: ScanMode.CRAWL,
        targets: ['https://example.com/'],
        crawlMaxPages: 250,
        crawlMaxDepth: 4,
        crawlStrategy: CrawlStrategy.SameHostname,
        crawlGlobs: null,
        crawlExcludeGlobs: null,
      });

      mockRepo.create.mockReturnValue(saved);
      mockRepo.save.mockResolvedValue(saved);
      mockRepo.findOne.mockResolvedValue({ ...saved, issues: [] });

      await service.create(dto);

      expect(mockQueue.addScanJob).toHaveBeenCalledWith(saved.id);
    });

    it('encrypts and stores basic auth credentials without returning them', async () => {
      const dto: CreateSingleUrlScanDto = {
        mode: ScanMode.SINGLE_URL,
        url: 'https://example.com',
        scanOptions: {
          basicAuth: {
            username: 'scanner-user',
            password: 'scanner-password',
          },
        },
      };
      const saved = makeScan({
        basicAuthUsernameEncrypted: 'enc-user',
        basicAuthPasswordEncrypted: 'enc-pass',
      });
      mockBasicAuthCrypto.encryptCredentials.mockReturnValue({
        encryptedUsername: 'enc-user',
        encryptedPassword: 'enc-pass',
      });

      mockRepo.create.mockReturnValue(saved);
      mockRepo.save.mockResolvedValue(saved);
      mockRepo.findOne.mockResolvedValue({ ...saved, issues: [] });

      const result = await service.create(dto);

      expect(mockBasicAuthCrypto.encryptCredentials).toHaveBeenCalledWith({
        username: 'scanner-user',
        password: 'scanner-password',
      });
      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          basicAuthUsernameEncrypted: 'enc-user',
          basicAuthPasswordEncrypted: 'enc-pass',
        }),
      );
      expect(
        Object.prototype.hasOwnProperty.call(result.scanOptions, 'basicAuth'),
      ).toBe(false);
    });

    describe('AI audit gating', () => {
      const buildService = (agentOverrides: Record<string, unknown>) =>
        new ScanService(
          mockRepo as never,
          mockIssueRepo as never,
          mockAgentFindingRepo as never,
          mockQueue as never,
          mockBasicAuthCrypto as never,
          mockUrlPolicy as never,
          { ...agentConfig(), ...agentOverrides },
        );

      it('rejects an AI-audit request when the feature is disabled', async () => {
        // The default agentConfig() has enabled=false.
        await expect(
          service.create({
            mode: ScanMode.SINGLE_URL,
            url: 'https://example.com',
            aiAudit: { skills: [AgentSkill.IMAGE_ALT_TEXT] },
          }),
        ).rejects.toThrow(BadRequestException);
        expect(mockRepo.save).not.toHaveBeenCalled();
      });

      it('rejects a skill that is not on the server whitelist', async () => {
        const enabled = buildService({ enabled: true, allowedSkills: [] });
        await expect(
          enabled.create({
            mode: ScanMode.SINGLE_URL,
            url: 'https://example.com',
            aiAudit: { skills: [AgentSkill.IMAGE_ALT_TEXT] },
          }),
        ).rejects.toThrow(BadRequestException);
      });

      it('persists requested skills when enabled and whitelisted', async () => {
        const enabled = buildService({
          enabled: true,
          allowedSkills: ['image_alt_text'],
        });
        const saved = makeScan({
          aiAuditSkills: [AgentSkill.IMAGE_ALT_TEXT],
        });
        mockRepo.create.mockReturnValue(saved);
        mockRepo.save.mockResolvedValue(saved);
        mockRepo.findOne.mockResolvedValue({ ...saved, issues: [] });

        await enabled.create({
          mode: ScanMode.SINGLE_URL,
          url: 'https://example.com',
          aiAudit: { skills: [AgentSkill.IMAGE_ALT_TEXT] },
        });

        expect(mockRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({
            aiAuditSkills: [AgentSkill.IMAGE_ALT_TEXT],
          }),
        );
      });
    });

    // Cross-field rejection (e.g. crawlOptions on single_url) is now enforced
    // by DiscriminatedBodyPipe; see discriminated-body.pipe.spec.ts.

    it('normalizes and deduplicates url_list targets', async () => {
      const dto: CreateUrlListScanDto = {
        mode: ScanMode.URL_LIST,
        urls: [
          'https://example.com/',
          'https://example.com',
          'https://example.com/about/',
        ],
      };
      const saved = makeScan({
        mode: ScanMode.URL_LIST,
        targets: ['https://example.com/', 'https://example.com/about'],
      });

      mockRepo.create.mockReturnValue(saved);
      mockRepo.save.mockResolvedValue(saved);
      mockRepo.findOne.mockResolvedValue({ ...saved, issues: [] });

      await service.create(dto);

      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: ScanMode.URL_LIST,
          targets: ['https://example.com/', 'https://example.com/about'],
        }),
      );
    });
  });

  describe('findAll()', () => {
    it('returns a paginated envelope of summaries with issue counts', async () => {
      const scans = [makeScan({ id: 2 }), makeScan({ id: 1 })];
      scanQueryBuilder.getManyAndCount.mockResolvedValue([scans, 2]);
      issueCountQueryBuilder.getRawMany.mockResolvedValue([
        { scanId: 2, impact: IssueImpact.CRITICAL, count: '3' },
        { scanId: 1, impact: IssueImpact.MINOR, count: '1' },
      ]);

      const result = await service.findAll({ limit: 20, offset: 0 });

      expect(scanQueryBuilder.skip).toHaveBeenCalledWith(0);
      expect(scanQueryBuilder.take).toHaveBeenCalledWith(20);
      expect(result.total).toBe(2);
      expect(result.limit).toBe(20);
      expect(result.offset).toBe(0);
      expect(result.items).toHaveLength(2);
      const first = result.items.find((s) => s.id === 2);
      expect(first?.issueCounts.critical).toBe(3);
      expect(first?.totalIssueCount).toBe(3);
      // Summaries never carry the heavy violations array.
      expect(first).not.toHaveProperty('violations');
    });

    it('applies a SQL LIKE narrow and confirms the exact target match', async () => {
      const scans = [
        makeScan({ id: 1, targets: ['https://example.com/'] }),
        makeScan({ id: 2, targets: ['https://example.com.evil/'] }),
      ];
      scanQueryBuilder.getManyAndCount.mockResolvedValue([scans, 2]);

      const result = await service.findAll({
        limit: 20,
        offset: 0,
        target: 'https://example.com',
      });

      // The value is wrapped in JSON element quotes so the LIKE is an
      // exact-element match, not a substring one.
      expect(scanQueryBuilder.andWhere).toHaveBeenCalledWith(
        'scan.targets LIKE :target',
        { target: '%"https://example.com/"%' },
      );
      // Any residual false positive (example.com.evil) is dropped by the JS confirm.
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe(1);
    });
  });

  describe('findOne()', () => {
    it('returns scan with grouped violations and issue page URLs', async () => {
      mockRepo.findOne.mockResolvedValue(
        makeScan({ status: ScanStatus.COMPLETED }),
      );
      mockIssueRepo.find.mockResolvedValue([makeIssue()]);

      const result = await service.findOne(1);

      expect(result.id).toBe(1);
      expect(result.status).toBe(ScanStatus.COMPLETED);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].rule.id).toBe('color-contrast');
      expect(result.violations[0].impact).toBe(IssueImpact.SERIOUS);
      expect(result.violations[0].issues[0].pageUrl).toBe(
        'https://example.com',
      );
      expect(result.totalIssueCount).toBe(1);
    });

    it('throws NotFoundException when scan does not exist', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      await expect(service.findOne(999)).rejects.toThrow(NotFoundException);
    });

    it('omits aiAudit when the audit was not requested', async () => {
      mockRepo.findOne.mockResolvedValue(
        makeScan({ status: ScanStatus.COMPLETED, aiAuditSkills: null }),
      );
      mockIssueRepo.find.mockResolvedValue([]);

      const result = await service.findOne(1);

      expect(result.aiAudit).toBeNull();
    });

    it('reports aiAudit completed when work units were evaluated', async () => {
      mockRepo.findOne.mockResolvedValue(
        makeScan({
          status: ScanStatus.COMPLETED,
          aiAuditSkills: [AgentSkill.IMAGE_ALT_TEXT],
          aiTasksTotal: 3,
          aiTasksCompleted: 3,
        }),
      );
      mockIssueRepo.find.mockResolvedValue([]);

      const result = await service.findOne(1);

      expect(result.aiAudit?.status).toBe(AiAuditStatus.COMPLETED);
    });

    it('reports aiAudit skipped when requested but nothing was eligible', async () => {
      mockRepo.findOne.mockResolvedValue(
        makeScan({
          status: ScanStatus.COMPLETED,
          aiAuditSkills: [AgentSkill.IMAGE_ALT_TEXT],
          aiTasksTotal: 0,
        }),
      );
      mockIssueRepo.find.mockResolvedValue([]);

      const result = await service.findOne(1);

      expect(result.aiAudit?.status).toBe(AiAuditStatus.SKIPPED);
    });

    it('reports aiAudit skipped when the scan failed before finishing', async () => {
      mockRepo.findOne.mockResolvedValue(
        makeScan({
          status: ScanStatus.FAILED,
          aiAuditSkills: [AgentSkill.IMAGE_ALT_TEXT],
          aiTasksTotal: 2,
        }),
      );
      mockIssueRepo.find.mockResolvedValue([]);

      const result = await service.findOne(1);

      expect(result.aiAudit?.status).toBe(AiAuditStatus.SKIPPED);
    });

    it('filters issues in SQL using a normalized pageUrl IN clause', async () => {
      mockRepo.findOne.mockResolvedValue(
        makeScan({ status: ScanStatus.COMPLETED }),
      );
      mockIssueRepo.find.mockResolvedValue([]);

      await service.findOne(1, ['https://example.com/about/']);

      expect(mockIssueRepo.find).toHaveBeenCalledWith({
        where: expect.objectContaining({
          scan: { id: 1 },
          pageUrl: expect.objectContaining({
            // In(['https://example.com/about']) after normalization.
            _value: ['https://example.com/about'],
          }),
        }),
      });
    });

    it('queries all issues (no pageUrl filter) when the option is omitted', async () => {
      mockRepo.findOne.mockResolvedValue(
        makeScan({ status: ScanStatus.COMPLETED }),
      );
      mockIssueRepo.find.mockResolvedValue([
        makeIssue({ id: 1, pageUrl: 'https://example.com/' }),
        makeIssue({ id: 2, pageUrl: 'https://example.com/about' }),
      ]);

      const result = await service.findOne(1);

      expect(mockIssueRepo.find).toHaveBeenCalledWith({
        where: { scan: { id: 1 } },
      });
      expect(result.totalIssueCount).toBe(2);
    });

    it('groups same rule+impact into one violation', async () => {
      mockRepo.findOne.mockResolvedValue(
        makeScan({ status: ScanStatus.COMPLETED }),
      );
      mockIssueRepo.find.mockResolvedValue([
        makeIssue({ id: 1, selector: '.a' }),
        makeIssue({ id: 2, selector: '.b' }),
      ]);

      const result = await service.findOne(1);

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].issues).toHaveLength(2);
      expect(result.totalIssueCount).toBe(2);
    });

    it('separates same rule with different impacts into different violations', async () => {
      mockRepo.findOne.mockResolvedValue(
        makeScan({ status: ScanStatus.COMPLETED }),
      );
      mockIssueRepo.find.mockResolvedValue([
        makeIssue({ id: 1, impact: IssueImpact.SERIOUS }),
        makeIssue({ id: 2, impact: IssueImpact.CRITICAL }),
      ]);

      const result = await service.findOne(1);

      expect(result.violations).toHaveLength(2);
      expect(
        result.violations.some((v) => v.impact === IssueImpact.SERIOUS),
      ).toBe(true);
      expect(
        result.violations.some((v) => v.impact === IssueImpact.CRITICAL),
      ).toBe(true);
    });
  });

  describe('create() enqueue failure', () => {
    it('leaves the scan PENDING and throws 503 when the queue is unavailable', async () => {
      const saved = makeScan();
      mockRepo.create.mockReturnValue(saved);
      mockRepo.save.mockResolvedValue(saved);
      mockRepo.update = jest.fn().mockResolvedValue(undefined);
      mockQueue.addScanJob.mockRejectedValue(new Error('redis down'));

      await expect(
        service.create({
          mode: ScanMode.SINGLE_URL,
          url: 'https://example.com',
        }),
      ).rejects.toThrow(ServiceUnavailableException);

      // The row must stay PENDING (not moved to a terminal FAILED) so the
      // reconciliation sweep, which only re-enqueues stale PENDING/RUNNING
      // scans, can recover it. So the failure path performs no status update.
      expect(mockRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('cancel()', () => {
    it('cancels a pending scan and returns the updated scan', async () => {
      mockRepo.findOne.mockResolvedValueOnce(
        makeScan({ status: ScanStatus.PENDING }),
      );
      // Second findOne (inside findOne()) returns the canceled scan.
      mockRepo.findOne.mockResolvedValueOnce(
        makeScan({ status: ScanStatus.CANCELED }),
      );
      mockRepo.update = jest.fn().mockResolvedValue(undefined);

      const result = await service.cancel(1);

      expect(mockQueue.cancelScanJob).toHaveBeenCalledWith(1);
      expect(mockRepo.update).toHaveBeenCalledWith(1, {
        status: ScanStatus.CANCELED,
      });
      expect(result.status).toBe(ScanStatus.CANCELED);
    });

    it('throws NotFoundException for an unknown scan', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      await expect(service.cancel(999)).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException when the scan is already terminal', async () => {
      mockRepo.findOne.mockResolvedValue(
        makeScan({ status: ScanStatus.COMPLETED }),
      );
      await expect(service.cancel(1)).rejects.toThrow(ConflictException);
      expect(mockQueue.cancelScanJob).not.toHaveBeenCalled();
    });
  });

  describe('remove()', () => {
    it('deletes scan by id relying on cascade for issues', async () => {
      mockRepo.delete = jest.fn().mockResolvedValue({ affected: 1 });

      await expect(service.remove(1)).resolves.not.toThrow();
      expect(mockRepo.delete).toHaveBeenCalledWith(1);
      expect(mockQueue.cancelScanJob).toHaveBeenCalledWith(1);
    });

    it('throws NotFoundException when scan does not exist', async () => {
      mockRepo.delete = jest.fn().mockResolvedValue({ affected: 0 });
      await expect(service.remove(999)).rejects.toThrow(NotFoundException);
    });
  });
});
