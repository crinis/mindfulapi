import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ScanService } from './scan.service';
import { ScanQueueService } from './scan-queue.service';
import { Scan } from '../entities/scan.entity';
import { Issue } from '../entities/issue.entity';
import { ScanStatus } from '../enums/scan-status.enum';
import { IssueImpact } from '../enums/issue-impact.enum';
import { CreateScanDto } from '../dto/create-scan.dto';

const makeIssue = (overrides: Partial<Issue> = {}): Issue =>
  ({
    id: 1,
    ruleId: 'color-contrast',
    description: 'Elements must have sufficient color contrast',
    impact: IssueImpact.SERIOUS,
    selector: '.btn',
    context: '<button class="btn">Click</button>',
    helpUrl:
      'https://dequeuniversity.com/rules/axe/4.11/color-contrast?application=playwright',
    ...overrides,
  }) as Issue;

const makeScan = (overrides: Partial<Scan> = {}): Scan =>
  ({
    id: 1,
    url: 'https://example.com',
    rootElement: undefined,
    status: ScanStatus.PENDING,
    issues: [],
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  }) as Scan;

describe('ScanService', () => {
  let service: ScanService;
  let mockRepo: jest.Mocked<Record<string, jest.Mock>>;
  let mockQueue: jest.Mocked<Pick<ScanQueueService, 'addScanJob'>>;

  beforeEach(async () => {
    mockRepo = {
      create: jest.fn(),
      save: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      remove: jest.fn(),
    };

    mockQueue = { addScanJob: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScanService,
        { provide: getRepositoryToken(Scan), useValue: mockRepo },
        { provide: ScanQueueService, useValue: mockQueue },
      ],
    }).compile();

    service = module.get<ScanService>(ScanService);
  });

  describe('create()', () => {
    it('saves the scan, queues a job, and returns the created scan', async () => {
      const dto: CreateScanDto = { url: 'https://example.com' };
      const saved = makeScan();

      mockRepo.create.mockReturnValue(saved);
      mockRepo.save.mockResolvedValue(saved);
      // findOne called by create → findOne internally
      mockRepo.findOne.mockResolvedValue({ ...saved, issues: [] });

      const result = await service.create(dto);

      expect(mockRepo.create).toHaveBeenCalledWith({
        url: dto.url,
        rootElement: undefined,
        status: ScanStatus.PENDING,
      });
      expect(mockRepo.save).toHaveBeenCalledWith(saved);
      expect(mockQueue.addScanJob).toHaveBeenCalledWith(
        saved.id,
        dto.url,
        undefined,
        undefined,
      );
      expect(result.id).toBe(saved.id);
      expect(result.status).toBe(ScanStatus.PENDING);
      expect(result.violations).toEqual([]);
      expect(result.totalIssueCount).toBe(0);
    });

    it('passes rootElement and ruleIds to the queue', async () => {
      const dto: CreateScanDto = {
        url: 'https://example.com',
        rootElement: 'main',
        ruleIds: ['image-alt'],
      };
      const saved = makeScan({ rootElement: 'main' });
      mockRepo.create.mockReturnValue(saved);
      mockRepo.save.mockResolvedValue(saved);
      mockRepo.findOne.mockResolvedValue({ ...saved, issues: [] });

      await service.create(dto);

      expect(mockQueue.addScanJob).toHaveBeenCalledWith(
        saved.id,
        dto.url,
        'main',
        ['image-alt'],
      );
    });
  });

  describe('findAll()', () => {
    it('returns all scans when no options are given', async () => {
      const scans = [makeScan({ id: 2 }), makeScan({ id: 1 })];
      mockRepo.find.mockResolvedValue(scans.map((s) => ({ ...s, issues: [] })));

      const result = await service.findAll();

      expect(mockRepo.find).toHaveBeenCalledWith({
        where: undefined,
        relations: ['issues'],
        order: { createdAt: 'DESC' },
      });
      expect(result).toHaveLength(2);
    });

    it('filters by URL when options.url is provided', async () => {
      const scan = makeScan({ issues: [] });
      mockRepo.find.mockResolvedValue([scan]);

      const result = await service.findAll({ url: 'https://example.com' });

      expect(mockRepo.find).toHaveBeenCalledWith({
        where: { url: 'https://example.com' },
        relations: ['issues'],
        order: { createdAt: 'DESC' },
      });
      expect(result).toHaveLength(1);
    });

    it('returns empty array when there are no scans', async () => {
      mockRepo.find.mockResolvedValue([]);
      expect(await service.findAll()).toEqual([]);
    });
  });

  describe('findOne()', () => {
    it('returns the scan with enriched violation data', async () => {
      const issue = makeIssue();
      const scan = makeScan({ status: ScanStatus.COMPLETED, issues: [issue] });
      mockRepo.findOne.mockResolvedValue(scan);

      const result = await service.findOne(1);

      expect(result.id).toBe(1);
      expect(result.status).toBe(ScanStatus.COMPLETED);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].rule.id).toBe('color-contrast');
      expect(result.violations[0].impact).toBe(IssueImpact.SERIOUS);
      expect(result.violations[0].issues[0].selector).toBe('.btn');
      expect(result.totalIssueCount).toBe(1);
    });

    it('throws NotFoundException when scan does not exist', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      await expect(service.findOne(999)).rejects.toThrow(NotFoundException);
    });

    it('groups issues from the same rule into a single violation', async () => {
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

    it('creates separate violations for different rules', async () => {
      const issues = [
        makeIssue({ id: 1, ruleId: 'color-contrast', selector: '.a' }),
        makeIssue({
          id: 2,
          ruleId: 'image-alt',
          description: 'Images must have alt text',
          selector: 'img',
        }),
      ];
      mockRepo.findOne.mockResolvedValue(
        makeScan({ status: ScanStatus.COMPLETED, issues }),
      );

      const result = await service.findOne(1);

      expect(result.violations).toHaveLength(2);
      expect(result.totalIssueCount).toBe(2);
    });
  });

  describe('remove()', () => {
    it('removes the scan when it exists', async () => {
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
