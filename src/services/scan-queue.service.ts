import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

/**
 * Data for a scan processing job in the BullMQ queue.
 */
export interface ScanJobData {
  scanId: number;
  url: string;
  rootElement?: string;
  ruleIds?: string[];
}

/**
 * Service for queuing accessibility scan jobs with BullMQ.
 */
@Injectable()
export class ScanQueueService {
  constructor(
    @InjectQueue('scan-processing') private scanQueue: Queue<ScanJobData>,
  ) {}

  async addScanJob(
    scanId: number,
    url: string,
    rootElement?: string,
    ruleIds?: string[],
  ): Promise<void> {
    await this.scanQueue.add(
      'process-scan',
      { scanId, url, rootElement, ruleIds },
      { delay: 1000 },
    );
  }

  async getQueueStatus() {
    const [waiting, active, completed, failed] = await Promise.all([
      this.scanQueue.getWaiting(),
      this.scanQueue.getActive(),
      this.scanQueue.getCompleted(),
      this.scanQueue.getFailed(),
    ]);

    return {
      waiting: waiting.length,
      active: active.length,
      completed: completed.length,
      failed: failed.length,
    };
  }
}
