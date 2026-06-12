import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CleanupService } from './cleanup.service';
import { Scan } from '../entities/scan.entity';
import { ScanStatus } from '../enums/scan-status.enum';

const makeScan = (id: number): Partial<Scan> => ({
  id,
  status: ScanStatus.COMPLETED,
  createdAt: new Date('2020-01-01'),
  updatedAt: new Date('2020-01-01'),
});

describe('CleanupService', () => {
  let service: CleanupService;
  let mockRepo: jest.Mocked<Record<string, jest.Mock>>;

  beforeEach(async () => {
    mockRepo = {
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CleanupService,
        { provide: getRepositoryToken(Scan), useValue: mockRepo },
      ],
    }).compile();

    service = module.get<CleanupService>(CleanupService);
  });

  afterEach(() => {
    delete process.env.CLEANUP_ENABLED;
    delete process.env.CLEANUP_RETENTION_DAYS;
    delete process.env.CLEANUP_INTERVAL;
  });

  describe('getCleanupConfig()', () => {
    it('returns defaults when no env vars set', () => {
      delete process.env.CLEANUP_ENABLED;
      delete process.env.CLEANUP_RETENTION_DAYS;
      delete process.env.CLEANUP_INTERVAL;

      const config = service.getCleanupConfig();

      expect(config.enabled).toBe(true);
      expect(config.retentionDays).toBe(30);
      expect(typeof config.interval).toBe('string');
      expect(config.interval.length).toBeGreaterThan(0);
    });

    it('reflects CLEANUP_INTERVAL env var', () => {
      process.env.CLEANUP_INTERVAL = '0 3 * * *';
      // Re-instantiate to pick up env var (CleanupService reads env in constructor)
      const freshService = new (CleanupService as any)(mockRepo);
      const config = freshService.getCleanupConfig();
      expect(config.interval).toBe('0 3 * * *');
    });
  });

  describe('performCleanup()', () => {
    it('does nothing when there are no old scans', async () => {
      mockRepo.find.mockResolvedValue([]);
      await service.performCleanup();
      expect(mockRepo.delete).not.toHaveBeenCalled();
    });

    it('deletes scans older than retention period', async () => {
      const oldScans = [makeScan(1), makeScan(2)];
      mockRepo.find.mockResolvedValue(oldScans);
      mockRepo.delete.mockResolvedValue({ affected: 2 });

      await service.performCleanup();

      expect(mockRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ createdAt: expect.any(Object) }),
          select: { id: true },
        }),
      );
      expect(mockRepo.delete).toHaveBeenCalledWith([1, 2]);
    });

    it('queries with a cutoff date in the past', async () => {
      mockRepo.find.mockResolvedValue([]);
      const before = new Date();

      await service.performCleanup();

      const findCall = mockRepo.find.mock.calls[0][0];
      const cutoff: Date = findCall.where.createdAt.value;
      expect(cutoff.getTime()).toBeLessThan(before.getTime());
    });
  });

  describe('triggerManualCleanup()', () => {
    it('delegates to performCleanup', async () => {
      const spy = jest
        .spyOn(service, 'performCleanup')
        .mockResolvedValue(undefined);

      await service.triggerManualCleanup();

      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('performScheduledCleanup()', () => {
    it('runs cleanup when enabled', async () => {
      const spy = jest
        .spyOn(service, 'performCleanup')
        .mockResolvedValue(undefined);

      await service.performScheduledCleanup();

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('skips cleanup when CLEANUP_ENABLED=false', async () => {
      process.env.CLEANUP_ENABLED = 'false';
      // Re-instantiate to pick up the disabled flag
      const disabledService = new (CleanupService as any)(mockRepo);
      const spy = jest
        .spyOn(disabledService, 'performCleanup')
        .mockResolvedValue(undefined);

      await disabledService.performScheduledCleanup();

      expect(spy).not.toHaveBeenCalled();
    });
  });
});
