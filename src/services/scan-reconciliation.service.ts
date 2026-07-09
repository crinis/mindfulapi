import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Scan } from '../entities/scan.entity';
import { ScanStatus } from '../enums/scan-status.enum';
import { ScanQueueService } from './scan-queue.service';

/** Age after which a PENDING scan with no live job is re-enqueued. */
const PENDING_STALE_MS = 60_000;
/** Age after which a RUNNING scan with no active job is considered stuck. */
const RUNNING_STALE_MS = 15 * 60_000;
/** How often the periodic reconciliation sweep runs. */
const SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * Recovers scans orphaned by a crash or a failed enqueue.
 *
 * Because persist and enqueue are not transactional (single Redis, single
 * node — an outbox would be overkill), a scan can be left PENDING if the
 * process died between the two, or RUNNING if a worker was killed mid-scan.
 * This sweeper re-enqueues such scans; processing is idempotent because
 * {@link ScanProcessor} resets results at the start of every attempt.
 */
@Injectable()
export class ScanReconciliationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScanReconciliationService.name);

  constructor(
    @InjectRepository(Scan)
    private readonly scanRepository: Repository<Scan>,
    private readonly scanQueueService: ScanQueueService,
  ) {}

  /**
   * Runs an initial reconciliation once the app is ready.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.reconcile();
  }

  /**
   * Periodically re-checks for orphaned scans.
   */
  @Interval(SWEEP_INTERVAL_MS)
  async scheduledReconcile(): Promise<void> {
    await this.reconcile();
  }

  /**
   * Re-enqueues stale PENDING/RUNNING scans that have no live queue job.
   */
  async reconcile(): Promise<void> {
    const now = Date.now();
    const pendingCutoff = new Date(now - PENDING_STALE_MS);
    const runningCutoff = new Date(now - RUNNING_STALE_MS);

    const candidates = await this.scanRepository.find({
      where: [
        { status: ScanStatus.PENDING, updatedAt: LessThan(pendingCutoff) },
        { status: ScanStatus.RUNNING, updatedAt: LessThan(runningCutoff) },
      ],
      select: { id: true, status: true },
    });

    for (const scan of candidates) {
      const state = await this.scanQueueService.getScanJobState(scan.id);
      // A job that is waiting/active/delayed will run (or is running); skip it.
      if (state && state !== 'failed' && state !== 'completed') {
        continue;
      }

      this.logger.warn(
        `Re-enqueueing orphaned ${scan.status} scan ${scan.id} (job state: ${state ?? 'none'})`,
      );
      try {
        // Clear any lingering terminal job so the deterministic id is free,
        // reset to PENDING, then re-enqueue (processing is idempotent).
        await this.scanQueueService.cancelScanJob(scan.id);
        await this.scanRepository.update(scan.id, {
          status: ScanStatus.PENDING,
        });
        await this.scanQueueService.addScanJob(scan.id);
      } catch (error) {
        this.logger.error(
          `Failed to re-enqueue scan ${scan.id}: ${String(error)}`,
        );
      }
    }
  }
}
