import { ScanQueueService } from './scan-queue.service';

describe('ScanQueueService', () => {
  it('adds process-scan jobs with a deterministic job id', async () => {
    const mockQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ScanQueueService(mockQueue as any);

    await service.addScanJob(42);

    expect(mockQueue.add).toHaveBeenCalledWith(
      'process-scan',
      { scanId: 42 },
      { jobId: 'scan-42' },
    );
  });

  it('removes a waiting job on cancel and reports its state', async () => {
    const job = {
      getState: jest.fn().mockResolvedValue('waiting'),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const mockQueue = { getJob: jest.fn().mockResolvedValue(job) };
    const service = new ScanQueueService(mockQueue as any);

    const state = await service.cancelScanJob(42);

    expect(mockQueue.getJob).toHaveBeenCalledWith('scan-42');
    expect(job.remove).toHaveBeenCalled();
    expect(state).toBe('waiting');
  });

  it('does not remove an active job on cancel', async () => {
    const job = {
      getState: jest.fn().mockResolvedValue('active'),
      remove: jest.fn(),
    };
    const mockQueue = { getJob: jest.fn().mockResolvedValue(job) };
    const service = new ScanQueueService(mockQueue as any);

    const state = await service.cancelScanJob(42);

    expect(job.remove).not.toHaveBeenCalled();
    expect(state).toBe('active');
  });

  it('returns null when cancelling a scan with no job', async () => {
    const mockQueue = { getJob: jest.fn().mockResolvedValue(null) };
    const service = new ScanQueueService(mockQueue as any);

    expect(await service.cancelScanJob(42)).toBeNull();
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
