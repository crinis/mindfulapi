import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ScanService } from './scan.service';
import { ScanQueueService } from './scan-queue.service';
import { BasicAuthCryptoService } from './basic-auth-crypto.service';
import { Scan } from '../entities/scan.entity';
import { Issue } from '../entities/issue.entity';
import { ScanStatus } from '../enums/scan-status.enum';
import { IssueImpact } from '../enums/issue-impact.enum';
import { CreateScanDto } from '../dto/scan/request';
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

const makeScan = (overrides: Partial<Scan> = {}): Scan =>
  ({
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
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  }) as Scan;

describe('ScanService', () => {
  let service: ScanService;
  let mockRepo: jest.Mocked<Record<string, jest.Mock>>;
  let mockQueue: jest.Mocked<Pick<ScanQueueService, 'addScanJob'>>;
  let mockBasicAuthCrypto: jest.Mocked<
    Pick<BasicAuthCryptoService, 'encryptCredentials'>
  >;

  beforeEach(async () => {
    mockRepo = {
      create: jest.fn(),
      save: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      remove: jest.fn(),
    };

    mockQueue = { addScanJob: jest.fn().mockResolvedValue(undefined) };
    mockBasicAuthCrypto = {
      encryptCredentials: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScanService,
        { provide: getRepositoryToken(Scan), useValue: mockRepo },
        { provide: ScanQueueService, useValue: mockQueue },
        { provide: BasicAuthCryptoService, useValue: mockBasicAuthCrypto },
      ],
    }).compile();

    service = module.get<ScanService>(ScanService);
  });

  describe('create()', () => {
    it('saves a single_url scan, queues a job, and returns the created scan', async () => {
      const dto: CreateScanDto = {
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
      const dto: CreateScanDto = {
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
      const dto: CreateScanDto = {
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

    it('throws when mode-specific fields are invalid', async () => {
      const dto: CreateScanDto = {
        mode: ScanMode.SINGLE_URL,
        url: 'https://example.com',
        crawlOptions: { maxPages: 20 },
      };

      await expect(service.create(dto)).rejects.toThrow(BadRequestException);
    });

    it('normalizes and deduplicates url_list targets', async () => {
      const dto: CreateScanDto = {
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
    it('returns all scans when no options are given', async () => {
      const scans = [makeScan({ id: 2 }), makeScan({ id: 1 })];
      mockRepo.find.mockResolvedValue(scans.map((s) => ({ ...s, issues: [] })));

      const result = await service.findAll();

      expect(mockRepo.find).toHaveBeenCalledWith({
        relations: ['issues'],
        order: { createdAt: 'DESC' },
      });
      expect(result).toHaveLength(2);
    });

    it('filters by target when options.target is provided', async () => {
      const scans = [
        makeScan({ id: 1, targets: ['https://example.com/'], issues: [] }),
        makeScan({ id: 2, targets: ['https://other.example/'], issues: [] }),
      ];
      mockRepo.find.mockResolvedValue(scans);

      const result = await service.findAll({ target: 'https://example.com' });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(1);
    });

    it('normalizes filter target before matching', async () => {
      const scans = [
        makeScan({ id: 1, targets: ['https://example.com/'], issues: [] }),
      ];
      mockRepo.find.mockResolvedValue(scans);

      const result = await service.findAll({ target: 'https://example.com/' });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(1);
    });
  });

  describe('findOne()', () => {
    it('returns scan with grouped violations and issue page URLs', async () => {
      const issue = makeIssue();
      const scan = makeScan({ status: ScanStatus.COMPLETED, issues: [issue] });
      mockRepo.findOne.mockResolvedValue(scan);

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

    it('filters issues to exact pageUrl when a single-element pageUrl array is provided', async () => {
      const issues = [
        makeIssue({
          id: 1,
          pageUrl: 'https://example.com/about',
          selector: '.a',
        }),
        makeIssue({
          id: 2,
          pageUrl: 'https://example.com/contact',
          selector: '.b',
        }),
        makeIssue({
          id: 3,
          pageUrl: 'https://example.com/about',
          selector: '.c',
        }),
      ];
      mockRepo.findOne.mockResolvedValue(
        makeScan({ status: ScanStatus.COMPLETED, issues }),
      );

      const result = await service.findOne(1, ['https://example.com/about']);

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].issues).toHaveLength(2);
      expect(
        result.violations[0].issues.every(
          (i) => i.pageUrl === 'https://example.com/about',
        ),
      ).toBe(true);
      expect(result.totalIssueCount).toBe(2);
    });

    it('filters issues to any of the given URLs when multiple pageUrls are provided', async () => {
      const issues = [
        makeIssue({
          id: 1,
          pageUrl: 'https://example.com/about',
          selector: '.a',
        }),
        makeIssue({
          id: 2,
          pageUrl: 'https://example.com/contact',
          selector: '.b',
        }),
        makeIssue({
          id: 3,
          pageUrl: 'https://example.com/pricing',
          selector: '.c',
        }),
      ];
      mockRepo.findOne.mockResolvedValue(
        makeScan({ status: ScanStatus.COMPLETED, issues }),
      );

      const result = await service.findOne(1, [
        'https://example.com/about',
        'https://example.com/contact',
      ]);

      expect(result.totalIssueCount).toBe(2);
      const pageUrls = result.violations.flatMap((v) =>
        v.issues.map((i) => i.pageUrl),
      );
      expect(pageUrls).not.toContain('https://example.com/pricing');
    });

    it('omits violation groups entirely when no issues match the pageUrl filter', async () => {
      const issues = [
        makeIssue({
          id: 1,
          pageUrl: 'https://example.com/other',
          selector: '.a',
        }),
      ];
      mockRepo.findOne.mockResolvedValue(
        makeScan({ status: ScanStatus.COMPLETED, issues }),
      );

      const result = await service.findOne(1, ['https://example.com/about']);

      expect(result.violations).toHaveLength(0);
      expect(result.totalIssueCount).toBe(0);
    });

    it('returns all issues when pageUrl option is omitted', async () => {
      const issues = [
        makeIssue({ id: 1, pageUrl: 'https://example.com/' }),
        makeIssue({ id: 2, pageUrl: 'https://example.com/about' }),
      ];
      mockRepo.findOne.mockResolvedValue(
        makeScan({ status: ScanStatus.COMPLETED, issues }),
      );

      const result = await service.findOne(1);

      expect(result.totalIssueCount).toBe(2);
    });

    it('groups same rule+impact into one violation', async () => {
      const issues = [
        makeIssue({ id: 1, selector: '.a' }),
        makeIssue({ id: 2, selector: '.b' }),
      ];
      mockRepo.findOne.mockResolvedValue(
        makeScan({ status: ScanStatus.COMPLETED, issues }),
      );

      const result = await service.findOne(1);

      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].issues).toHaveLength(2);
      expect(result.totalIssueCount).toBe(2);
    });

    it('separates same rule with different impacts into different violations', async () => {
      const issues = [
        makeIssue({ id: 1, impact: IssueImpact.SERIOUS }),
        makeIssue({ id: 2, impact: IssueImpact.CRITICAL }),
      ];
      mockRepo.findOne.mockResolvedValue(
        makeScan({ status: ScanStatus.COMPLETED, issues }),
      );

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

  describe('remove()', () => {
    it('removes scan when it exists', async () => {
      const scan = makeScan();
      mockRepo.findOne.mockResolvedValue(scan);
      mockRepo.remove = jest.fn().mockResolvedValue(undefined);

      await expect(service.remove(1)).resolves.not.toThrow();
      expect(mockRepo.remove).toHaveBeenCalledWith(scan);
    });

    it('throws NotFoundException when scan does not exist', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      await expect(service.remove(999)).rejects.toThrow(NotFoundException);
    });
  });
});
