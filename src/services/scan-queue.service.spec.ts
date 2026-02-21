import { ScanQueueService } from './scan-queue.service';

describe('ScanQueueService', () => {
  it('adds process-scan jobs with scanId payload', async () => {
    const mockQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      getWaiting: jest.fn(),
      getActive: jest.fn(),
      getCompleted: jest.fn(),
      getFailed: jest.fn(),
    };
    const service = new ScanQueueService(mockQueue as any);

    await service.addScanJob(42);

    expect(mockQueue.add).toHaveBeenCalledWith('process-scan', { scanId: 42 });
  });

  it('returns queue status counts', async () => {
    const mockQueue = {
      add: jest.fn(),
      getWaitingCount: jest.fn().mockResolvedValue(2),
      getActiveCount: jest.fn().mockResolvedValue(1),
      getCompletedCount: jest.fn().mockResolvedValue(3),
      getFailedCount: jest.fn().mockResolvedValue(0),
    };
    const service = new ScanQueueService(mockQueue as any);

    await expect(service.getQueueStatus()).resolves.toEqual({
      waiting: 2,
      active: 1,
      completed: 3,
      failed: 0,
    });
  });
});
