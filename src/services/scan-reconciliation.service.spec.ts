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
      update: jest.fn().mockResolvedValue(undefined),
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

    expect(mockScanRepo.update).toHaveBeenCalledWith(7, {
      status: ScanStatus.PENDING,
    });
    expect(mockQueue.addScanJob).toHaveBeenCalledWith(7);
  });

  it('skips scans whose job is still waiting', async () => {
    mockScanRepo.find.mockResolvedValue([
      { id: 7, status: ScanStatus.PENDING },
    ]);
    mockQueue.getScanJobState.mockResolvedValue('waiting');

    await service.reconcile();

    expect(mockQueue.addScanJob).not.toHaveBeenCalled();
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
