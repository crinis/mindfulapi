import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

/** Queue name for scan processing jobs. */
export const SCAN_QUEUE_NAME = 'scan-processing';

/** Deterministic BullMQ job id for a scan, enabling idempotent enqueue/lookup. */
export const scanJobId = (scanId: number): string => `scan-${scanId}`;

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
   * Uses a deterministic job id so re-enqueueing the same scan is idempotent
   * and the job can be looked up or removed by scan id.
   *
   * @param scanId Scan run ID to process.
   */
  async addScanJob(scanId: number): Promise<void> {
    await this.scanQueue.add(
      'process-scan',
      { scanId },
      { jobId: scanJobId(scanId) },
    );
  }

  /**
   * Attempts to remove a waiting scan job from the queue.
   *
   * @param scanId Scan run ID whose job should be removed.
   * @returns The job's state before removal, or `null` when no job exists.
   */
  async cancelScanJob(scanId: number): Promise<string | null> {
    const job = await this.scanQueue.getJob(scanJobId(scanId));
    if (!job) {
      return null;
    }
    const state = await job.getState();
    // Only waiting/delayed jobs can be removed cleanly; an active job is
    // cancelled cooperatively by the processor.
    if (state !== 'active') {
      await job.remove().catch(() => undefined);
    }
    return state;
  }

  /**
   * Returns the BullMQ state of a scan's job, or `null` when none exists.
   *
   * @param scanId Scan run ID to look up.
   */
  async getScanJobState(scanId: number): Promise<string | null> {
    const job = await this.scanQueue.getJob(scanJobId(scanId));
    return job ? job.getState() : null;
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
