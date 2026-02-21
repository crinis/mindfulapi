import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

/**
 * Data for a scan processing job in the BullMQ queue.
 */
export interface ScanJobData {
  /** Scan run ID to process. */
  scanId: number;
}

/**
 * Snapshot counts for queue states used in operational monitoring.
 */
interface QueueStatusSnapshot {
  /** Number of jobs waiting to be processed. */
  waiting: number;
  /** Number of jobs currently being processed. */
  active: number;
  /** Number of completed jobs retained in queue history. */
  completed: number;
  /** Number of failed jobs retained in queue history. */
  failed: number;
}

/**
 * Service for queuing accessibility scan jobs with BullMQ.
 */
@Injectable()
export class ScanQueueService {
  /**
   * @param scanQueue BullMQ queue used for scan-processing jobs.
   */
  constructor(
    @InjectQueue('scan-processing') private scanQueue: Queue<ScanJobData>,
  ) {}

  /**
   * Enqueues a background job to process a scan run.
   *
   * @param scanId Scan run ID to process.
   */
  async addScanJob(scanId: number): Promise<void> {
    await this.scanQueue.add('process-scan', { scanId });
  }

  /**
   * Returns a lightweight queue health snapshot.
   */
  async getQueueStatus(): Promise<QueueStatusSnapshot> {
    const [waiting, active, completed, failed] = await Promise.all([
      this.scanQueue.getWaitingCount(),
      this.scanQueue.getActiveCount(),
      this.scanQueue.getCompletedCount(),
      this.scanQueue.getFailedCount(),
    ]);

    return { waiting, active, completed, failed };
  }
}
