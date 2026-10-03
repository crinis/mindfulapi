import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Not } from 'typeorm';
import { ScanService } from './scan.service';
import { ScanQueueService } from './scan-queue.service';
import { BasicAuthCryptoService } from './basic-auth-crypto.service';
import { UrlPolicyService } from './url-policy.service';
import { Scan } from '../entities/scan.entity';
import { Issue } from '../entities/issue.entity';
import { AgentFinding } from '../entities/agent-finding.entity';
import { agentConfig } from '../config/configuration';
import { ModelProviderFactory } from '../agent/harness/model-provider.factory';
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
import { ValidationProblemException } from '../exceptions/validation-problem.exception';

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
  reconcileAttempts: 0,
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
        {
          provide: agentConfig.KEY,
          useValue: {
            ...agentConfig(),
            allowedScanModes: [ScanMode.SINGLE_URL],
          },
        },
        ModelProviderFactory,
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
      /** A usable provider: OpenAI with a key, models from its profile. */
      const usableProvider = {
        provider: 'openai',
        model: null,
        apiKey: 'sk-test',
        baseUrl: null,
        skillModels: {},
      };
      const buildService = (agentOverrides: Record<string, unknown>) => {
        const settings = { ...agentConfig(), ...agentOverrides };
        return new ScanService(
          mockRepo as never,
          mockIssueRepo as never,
          mockAgentFindingRepo as never,
          mockQueue as never,
          mockBasicAuthCrypto as never,
          mockUrlPolicy as never,
          settings,
          new ModelProviderFactory(settings),
        );
      };
      const singleUrlAudit = (skills: AgentSkill[]) => ({
        mode: ScanMode.SINGLE_URL as const,
        url: 'https://example.com',
        aiAudit: { skills },
      });
      /** The rejection of a create request, for message assertions. */
      const rejectionOf = async (
        promise: Promise<unknown>,
      ): Promise<BadRequestException> => {
        try {
          await promise;
        } catch (error) {
          expect(error).toBeInstanceOf(BadRequestException);
          return error as BadRequestException;
        }
        throw new Error('expected the request to be rejected');
      };

      describe('when a requested skill cannot reach a model', () => {
        afterEach(() => {
          expect(mockRepo.save).not.toHaveBeenCalled();
          expect(mockQueue.addScanJob).not.toHaveBeenCalled();
        });

        it('names AGENT_PROVIDER when no provider is configured', async () => {
          const service = buildService({
            enabled: true,
            allowedSkills: ['image_alt_text'],
            ...usableProvider,
            provider: null,
          });

          const error = await rejectionOf(
            service.create(singleUrlAudit([AgentSkill.IMAGE_ALT_TEXT])),
          );

          expect(error.message).toMatch(/AGENT_PROVIDER/);
          expect(error.message).toMatch(/image_alt_text/);
        });

        it('names an unsupported provider', async () => {
          const service = buildService({
            enabled: true,
            allowedSkills: ['image_alt_text'],
            ...usableProvider,
            provider: 'gemini',
          });

          const error = await rejectionOf(
            service.create(singleUrlAudit([AgentSkill.IMAGE_ALT_TEXT])),
          );

          expect(error.message).toMatch(/AGENT_PROVIDER/);
          expect(error.message).toMatch(/gemini/);
        });

        it('names AGENT_MODEL when the provider has no model profile', async () => {
          const service = buildService({
            enabled: true,
            allowedSkills: ['page_title'],
            ...usableProvider,
            provider: 'anthropic',
          });

          const error = await rejectionOf(
            service.create(singleUrlAudit([AgentSkill.PAGE_TITLE])),
          );

          expect(error.message).toMatch(/AGENT_MODEL/);
          expect(error.message).toMatch(/AGENT_SKILL_PAGE_TITLE_MODEL/);
        });

        it('names the API key settings when the provider needs a key', async () => {
          const service = buildService({
            enabled: true,
            allowedSkills: ['image_alt_text'],
            ...usableProvider,
            apiKey: null,
          });

          const error = await rejectionOf(
            service.create(singleUrlAudit([AgentSkill.IMAGE_ALT_TEXT])),
          );

          expect(error.message).toMatch(/AGENT_API_KEY/);
          expect(error.message).toMatch(/AGENT_SKILL_IMAGE_ALT_TEXT_API_KEY/);
        });

        it('names AGENT_BASE_URL for openai-compatible without echoing the key', async () => {
          const service = buildService({
            enabled: true,
            allowedSkills: ['link_purpose'],
            ...usableProvider,
            provider: 'openai-compatible',
            model: 'llama',
            apiKey: 'sk-very-secret-value',
          });

          const error = await rejectionOf(
            service.create(singleUrlAudit([AgentSkill.LINK_PURPOSE])),
          );

          expect(error.message).toMatch(/AGENT_BASE_URL/);
          expect(error.message).not.toContain('sk-very-secret-value');
        });

        it('says an unconfigured skill can be removed from AGENT_SKILLS when the request names none', async () => {
          // Every enabled skill runs; only heading_structure lacks a key.
          const service = buildService({
            enabled: true,
            allowedSkills: ['page_title', 'heading_structure'],
            ...usableProvider,
            skillModels: {
              heading_structure: {
                provider: 'anthropic',
                model: 'claude',
                apiKey: null,
                baseUrl: 'https://gateway.example/secret-path',
                reasoningEffort: null,
              },
            },
          });

          const error = await rejectionOf(
            service.create({
              mode: ScanMode.SINGLE_URL,
              url: 'https://example.com',
              aiAudit: {},
            }),
          );

          expect(error.message).toMatch(
            /AGENT_SKILL_HEADING_STRUCTURE_API_KEY/,
          );
          expect(error.message).toMatch(
            /remove heading_structure from AGENT_SKILLS/,
          );
          expect(error.message).toMatch(/aiAudit\.skills/);
          expect(error.message).not.toMatch(/page_title/);
          expect(error.message).not.toContain('sk-test');
          expect(error.message).not.toContain('secret-path');
        });

        it('says an unconfigured skill can be left out of the requested skills', async () => {
          const service = buildService({
            enabled: true,
            allowedSkills: ['image_alt_text', 'page_title'],
            ...usableProvider,
            apiKey: null,
          });

          const error = await rejectionOf(
            service.create(
              singleUrlAudit([
                AgentSkill.IMAGE_ALT_TEXT,
                AgentSkill.PAGE_TITLE,
              ]),
            ),
          );

          expect(error.message).toMatch(
            /leave image_alt_text, page_title out of aiAudit\.skills/,
          );
        });
      });

      it('checks only the skills the scan requests', async () => {
        const service = buildService({
          enabled: true,
          allowedSkills: ['image_alt_text', 'page_title'],
          ...usableProvider,
          skillModels: {
            // Broken, but not requested below.
            image_alt_text: {
              provider: 'anthropic',
              model: null,
              apiKey: null,
              baseUrl: null,
              reasoningEffort: null,
            },
          },
        });
        const saved = makeScan({ aiAuditSkills: [AgentSkill.PAGE_TITLE] });
        mockRepo.create.mockReturnValue(saved);
        mockRepo.save.mockResolvedValue(saved);

        await service.create(singleUrlAudit([AgentSkill.PAGE_TITLE]));

        expect(mockQueue.addScanJob).toHaveBeenCalledWith(saved.id);
      });

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

      it.each([ScanMode.URL_LIST, ScanMode.CRAWL])(
        'rejects an AI audit for disallowed %s scans before persistence',
        async (mode) => {
          const enabled = buildService({
            enabled: true,
            allowedSkills: ['image_alt_text'],
            allowedScanModes: [ScanMode.SINGLE_URL],
          });
          const dto: CreateUrlListScanDto | CreateCrawlScanDto =
            mode === ScanMode.URL_LIST
              ? {
                  mode: ScanMode.URL_LIST,
                  urls: ['https://example.com', 'https://example.com/about'],
                  aiAudit: { skills: [AgentSkill.IMAGE_ALT_TEXT] },
                }
              : {
                  mode: ScanMode.CRAWL,
                  startUrls: ['https://example.com'],
                  aiAudit: { skills: [AgentSkill.IMAGE_ALT_TEXT] },
                };

          try {
            await enabled.create(dto);
            fail('expected rejection');
          } catch (error) {
            expect(error).toBeInstanceOf(ValidationProblemException);
            expect(
              (error as ValidationProblemException).fieldErrors,
            ).toContainEqual(expect.objectContaining({ pointer: '/aiAudit' }));
          }
          expect(mockRepo.save).not.toHaveBeenCalled();
          expect(mockQueue.addScanJob).not.toHaveBeenCalled();
          expect(mockUrlPolicy.assertAllowedTargets).not.toHaveBeenCalled();
        },
      );

      it('accepts a multi-page AI audit when its mode is explicitly allowed', async () => {
        const enabled = buildService({
          enabled: true,
          allowedSkills: ['image_alt_text'],
          allowedScanModes: [ScanMode.SINGLE_URL, ScanMode.URL_LIST],
          ...usableProvider,
        });
        const saved = makeScan({
          mode: ScanMode.URL_LIST,
          targets: ['https://example.com/', 'https://example.com/about'],
          aiAuditSkills: [AgentSkill.IMAGE_ALT_TEXT],
        });
        mockRepo.create.mockReturnValue(saved);
        mockRepo.save.mockResolvedValue(saved);

        await enabled.create({
          mode: ScanMode.URL_LIST,
          urls: ['https://example.com', 'https://example.com/about'],
          aiAudit: { skills: [AgentSkill.IMAGE_ALT_TEXT] },
        });

        expect(mockQueue.addScanJob).toHaveBeenCalledWith(saved.id);
      });

      it('uses every server-enabled skill when the request omits a list', async () => {
        const enabled = buildService({
          enabled: true,
          allowedSkills: ['image_alt_text', 'page_title'],
          ...usableProvider,
        });
        const saved = makeScan({
          aiAuditSkills: [AgentSkill.IMAGE_ALT_TEXT, AgentSkill.PAGE_TITLE],
        });
        mockRepo.create.mockReturnValue(saved);
        mockRepo.save.mockResolvedValue(saved);
        mockRepo.findOne.mockResolvedValue({ ...saved, issues: [] });

        await enabled.create({
          mode: ScanMode.SINGLE_URL,
          url: 'https://example.com',
          aiAudit: {},
        });

        expect(mockRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({
            aiAuditSkills: [AgentSkill.IMAGE_ALT_TEXT, AgentSkill.PAGE_TITLE],
          }),
        );
      });

      it('persists requested skills when enabled and whitelisted', async () => {
        const enabled = buildService({
          enabled: true,
          allowedSkills: ['image_alt_text'],
          ...usableProvider,
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

    it('returns AI findings of a page asked for with a trailing slash', async () => {
      mockRepo.findOne.mockResolvedValue(
        makeScan({
          status: ScanStatus.COMPLETED,
          aiAuditSkills: [AgentSkill.PAGE_TITLE],
          aiTasksTotal: 1,
        }),
      );
      // Collected at https://example.com/de/ and stored, like issues, under
      // the normalized page URL.
      const finding = {
        id: 3,
        skill: AgentSkill.PAGE_TITLE,
        pageUrl: 'https://example.com/de',
        category: 'inaccurate',
        severity: IssueImpact.MODERATE,
        confidence: 0.9,
        message: 'Title does not describe the page',
      } as AgentFinding;
      mockAgentFindingRepo.find.mockImplementation(
        ({ where }: { where: { pageUrl?: { _value: string[] } } }) =>
          Promise.resolve(
            where.pageUrl?._value.includes(finding.pageUrl!) ? [finding] : [],
          ),
      );

      const result = await service.findOne(1, ['https://example.com/de/']);

      expect(result.agentFindings).toEqual([
        expect.objectContaining({ pageUrl: 'https://example.com/de' }),
      ]);
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
    beforeEach(() => {
      const saved = makeScan({ id: 42 });
      mockRepo.create.mockReturnValue(saved);
      mockRepo.save.mockResolvedValue(saved);
      mockRepo.update = jest.fn().mockResolvedValue({ affected: 1 });
      mockQueue.addScanJob.mockRejectedValue(new Error('redis down'));
    });

    it('deletes the scan it could not queue and throws 503', async () => {
      mockRepo.delete = jest.fn().mockResolvedValue({ affected: 1 });

      await expect(
        service.create({
          mode: ScanMode.SINGLE_URL,
          url: 'https://example.com',
        }),
      ).rejects.toThrow(
        new ServiceUnavailableException(
          'The scan could not be queued for processing. Please retry.',
        ),
      );

      // A retrying client must not end up with a second scan: the reconciliation
      // sweep would otherwise enqueue this row later, running both (double
      // browser and AI spend) while the client never learns the first id.
      expect(mockRepo.delete).toHaveBeenCalledWith(42);
      expect(mockRepo.update).not.toHaveBeenCalled();
    });

    it('still answers 503 when the row cannot be deleted either', async () => {
      mockRepo.delete = jest.fn().mockRejectedValue(new Error('db locked'));

      await expect(
        service.create({
          mode: ScanMode.SINGLE_URL,
          url: 'https://example.com',
        }),
      ).rejects.toThrow(ServiceUnavailableException);
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
      mockRepo.update = jest.fn().mockResolvedValue({ affected: 1 });

      const result = await service.cancel(1);

      expect(mockQueue.cancelScanJob).toHaveBeenCalledWith(1);
      expect(mockRepo.update).toHaveBeenCalledWith(
        {
          id: 1,
          status: Not(
            In([ScanStatus.COMPLETED, ScanStatus.FAILED, ScanStatus.CANCELED]),
          ),
        },
        { status: ScanStatus.CANCELED },
      );
      expect(result.status).toBe(ScanStatus.CANCELED);
    });

    it('still answers with the canceled scan when its queued job cannot be removed', async () => {
      mockRepo.findOne.mockResolvedValueOnce(
        makeScan({ status: ScanStatus.PENDING }),
      );
      mockRepo.findOne.mockResolvedValueOnce(
        makeScan({ status: ScanStatus.CANCELED }),
      );
      mockRepo.update = jest.fn().mockResolvedValue({ affected: 1 });
      mockQueue.cancelScanJob.mockRejectedValue(
        new Error('Connection is closed.'),
      );
      const logError = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      // The scan is canceled either way; a worker picking up the job stops
      // at its first cancellation check. A 500 here would make a retrying
      // client get 409 for a cancel that worked.
      const result = await service.cancel(1);

      expect(result.status).toBe(ScanStatus.CANCELED);
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('Connection is closed.'),
      );
      logError.mockRestore();
    });

    it('throws ConflictException when the scan finished while being canceled', async () => {
      mockRepo.findOne.mockResolvedValueOnce(
        makeScan({ status: ScanStatus.RUNNING }),
      );
      mockRepo.findOne.mockResolvedValueOnce(
        makeScan({ status: ScanStatus.COMPLETED }),
      );
      mockRepo.update = jest.fn().mockResolvedValue({ affected: 0 });

      await expect(service.cancel(1)).rejects.toThrow(
        'Scan 1 is already completed and cannot be canceled.',
      );
      expect(mockQueue.cancelScanJob).not.toHaveBeenCalled();
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
