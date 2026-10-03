import { ScanReconciliationService } from './scan-reconciliation.service';
import { ScanStatus } from '../enums/scan-status.enum';

describe('ScanReconciliationService', () => {
  let mockScanRepo: { find: jest.Mock; update: jest.Mock };
  let mockQueue: {
    getScanJobState: jest.Mock;
    cancelScanJob: jest.Mock;
    addScanJob: jest.Mock;
  };
  let service: ScanReconciliationService;

  beforeEach(() => {
    mockScanRepo = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    mockQueue = {
      getScanJobState: jest.fn().mockResolvedValue(null),
      cancelScanJob: jest.fn().mockResolvedValue(null),
      addScanJob: jest.fn().mockResolvedValue(undefined),
    };
    service = new ScanReconciliationService(
      mockScanRepo as never,
      mockQueue as never,
    );
  });

  it('re-enqueues an orphaned PENDING scan with no live job', async () => {
    mockScanRepo.find.mockResolvedValue([
      { id: 7, status: ScanStatus.PENDING },
    ]);
    mockQueue.getScanJobState.mockResolvedValue(null);

    await service.reconcile();

    expect(mockScanRepo.update).toHaveBeenCalledWith(
      { id: 7, status: ScanStatus.PENDING },
      expect.objectContaining({ status: ScanStatus.PENDING }),
    );
    expect(mockQueue.addScanJob).toHaveBeenCalledWith(7);
  });

  it('does not re-enqueue a scan whose status changed since it was read', async () => {
    mockScanRepo.find.mockResolvedValue([
      { id: 9, status: ScanStatus.RUNNING },
    ]);
    // Canceled (or picked up) between the sweep's read and its write.
    mockScanRepo.update.mockResolvedValue({ affected: 0 });

    await service.reconcile();

    expect(mockScanRepo.update).toHaveBeenCalledWith(
      { id: 9, status: ScanStatus.RUNNING },
      expect.objectContaining({ status: ScanStatus.PENDING }),
    );
    expect(mockQueue.addScanJob).not.toHaveBeenCalled();
  });

  it('skips scans whose job is still waiting', async () => {
    mockScanRepo.find.mockResolvedValue([
      { id: 7, status: ScanStatus.PENDING },
    ]);
    mockQueue.getScanJobState.mockResolvedValue('waiting');

    await service.reconcile();

    expect(mockQueue.addScanJob).not.toHaveBeenCalled();
  });

  it('also recovers ANALYZING scans whose job died during the AI audit', async () => {
    mockScanRepo.find.mockResolvedValue([
      { id: 5, status: ScanStatus.ANALYZING, reconcileAttempts: 0 },
    ]);
    mockQueue.getScanJobState.mockResolvedValue(null);

    await service.reconcile();

    const where = mockScanRepo.find.mock.calls[0][0].where as Array<{
      status: ScanStatus;
      updatedAt: { value: Date };
    }>;
    const analyzing = where.find(
      (clause) => clause.status === ScanStatus.ANALYZING,
    );
    const running = where.find(
      (clause) => clause.status === ScanStatus.RUNNING,
    );
    // Same staleness as RUNNING; an active job (a long evaluation) is skipped.
    expect(analyzing?.updatedAt.value).toEqual(running?.updatedAt.value);
    expect(mockScanRepo.update).toHaveBeenCalledWith(
      { id: 5, status: ScanStatus.ANALYZING },
      { status: ScanStatus.PENDING, reconcileAttempts: 1 },
    );
    expect(mockQueue.addScanJob).toHaveBeenCalledWith(5);
  });

  it('counts each re-enqueue of a scan', async () => {
    mockScanRepo.find.mockResolvedValue([
      { id: 9, status: ScanStatus.RUNNING, reconcileAttempts: 2 },
    ]);

    await service.reconcile();

    expect(mockScanRepo.update).toHaveBeenCalledWith(
      { id: 9, status: ScanStatus.RUNNING },
      { status: ScanStatus.PENDING, reconcileAttempts: 3 },
    );
    expect(mockQueue.addScanJob).toHaveBeenCalledWith(9);
  });

  it('fails a scan instead of re-enqueueing it a fourth time', async () => {
    mockScanRepo.find.mockResolvedValue([
      { id: 9, status: ScanStatus.RUNNING, reconcileAttempts: 3 },
    ]);
    mockQueue.getScanJobState.mockResolvedValue('failed');

    await service.reconcile();

    expect(mockScanRepo.update).toHaveBeenCalledWith(
      { id: 9, status: ScanStatus.RUNNING },
      { status: ScanStatus.FAILED },
    );
    expect(mockQueue.addScanJob).not.toHaveBeenCalled();
    // The lingering failed job is cleared along with it.
    expect(mockQueue.cancelScanJob).toHaveBeenCalledWith(9);
  });

  describe('scans stuck for more than 24 hours', () => {
    const hoursAgo = (hours: number) =>
      new Date(Date.now() - hours * 60 * 60_000);

    it('reads when each candidate last changed', async () => {
      await service.reconcile();

      expect(mockScanRepo.find.mock.calls[0][0].select).toMatchObject({
        updatedAt: true,
      });
    });

    it.each([ScanStatus.PENDING, ScanStatus.RUNNING, ScanStatus.ANALYZING])(
      'fails a %s scan that last changed more than 24 h ago instead of re-running it',
      async (status) => {
        mockScanRepo.find.mockResolvedValue([
          { id: 4, status, reconcileAttempts: 0, updatedAt: hoursAgo(25) },
        ]);

        await service.reconcile();

        expect(mockScanRepo.update).toHaveBeenCalledWith(
          { id: 4, status },
          { status: ScanStatus.FAILED },
        );
        expect(mockScanRepo.update).toHaveBeenCalledTimes(1);
        expect(mockQueue.addScanJob).not.toHaveBeenCalled();
        expect(mockQueue.cancelScanJob).toHaveBeenCalledWith(4);
      },
    );

    it('still re-enqueues a stuck scan that changed less than 24 h ago', async () => {
      mockScanRepo.find.mockResolvedValue([
        {
          id: 6,
          status: ScanStatus.ANALYZING,
          reconcileAttempts: 0,
          updatedAt: hoursAgo(23),
        },
      ]);

      await service.reconcile();

      expect(mockScanRepo.update).toHaveBeenCalledWith(
        { id: 6, status: ScanStatus.ANALYZING },
        { status: ScanStatus.PENDING, reconcileAttempts: 1 },
      );
      expect(mockQueue.addScanJob).toHaveBeenCalledWith(6);
    });

    it('leaves an old scan with a live job alone', async () => {
      mockScanRepo.find.mockResolvedValue([
        {
          id: 8,
          status: ScanStatus.RUNNING,
          reconcileAttempts: 0,
          updatedAt: hoursAgo(48),
        },
      ]);
      mockQueue.getScanJobState.mockResolvedValue('active');

      await service.reconcile();

      expect(mockScanRepo.update).not.toHaveBeenCalled();
      expect(mockQueue.cancelScanJob).not.toHaveBeenCalled();
    });
  });

  it('re-enqueues a stale RUNNING scan whose job has failed', async () => {
    mockScanRepo.find.mockResolvedValue([
      { id: 9, status: ScanStatus.RUNNING },
    ]);
    mockQueue.getScanJobState.mockResolvedValue('failed');

    await service.reconcile();

    expect(mockQueue.cancelScanJob).toHaveBeenCalledWith(9);
    expect(mockQueue.addScanJob).toHaveBeenCalledWith(9);
  });
});
