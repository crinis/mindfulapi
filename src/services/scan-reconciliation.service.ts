import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Scan } from '../entities/scan.entity';
import { ScanStatus } from '../enums/scan-status.enum';
import { ScanQueueService } from './scan-queue.service';

/** Age after which a PENDING scan with no live job is re-enqueued. */
const PENDING_STALE_MS = 60_000;
/**
 * Age after which a RUNNING or ANALYZING scan with no live job is considered
 * stuck. A long AI audit keeps its job active and is never touched.
 */
const RUNNING_STALE_MS = 15 * 60_000;
/**
 * Re-enqueues per scan before reconciliation gives up and fails it, so a scan
 * that crashes its worker every time does not run forever.
 */
const MAX_RECONCILE_ATTEMPTS = 3;
/** How often the periodic reconciliation sweep runs. */
const SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * Recovers scans orphaned by a crash or a failed enqueue.
 *
 * Because persist and enqueue are not transactional (single Redis, single
 * node — an outbox would be overkill), a scan can be left PENDING if the
 * process died between the two, or RUNNING/ANALYZING if a worker was killed
 * mid-scan. This sweeper re-enqueues such scans; processing is idempotent
 * because {@link ScanProcessor} resets results at the start of every attempt.
 * After {@link MAX_RECONCILE_ATTEMPTS} re-enqueues a scan is marked FAILED.
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
   * Re-enqueues stale PENDING/RUNNING/ANALYZING scans that have no live queue
   * job, or fails them once they used up their re-enqueues.
   */
  async reconcile(): Promise<void> {
    const now = Date.now();
    const pendingCutoff = new Date(now - PENDING_STALE_MS);
    const runningCutoff = new Date(now - RUNNING_STALE_MS);

    const candidates = await this.scanRepository.find({
      where: [
        { status: ScanStatus.PENDING, updatedAt: LessThan(pendingCutoff) },
        { status: ScanStatus.RUNNING, updatedAt: LessThan(runningCutoff) },
        { status: ScanStatus.ANALYZING, updatedAt: LessThan(runningCutoff) },
      ],
      select: { id: true, status: true, reconcileAttempts: true },
    });

    for (const scan of candidates) {
      const state = await this.scanQueueService.getScanJobState(scan.id);
      // A job that is waiting/active/delayed will run (or is running); skip it.
      if (state && state !== 'failed' && state !== 'completed') {
        continue;
      }

      const attempts = scan.reconcileAttempts ?? 0;
      if (attempts >= MAX_RECONCILE_ATTEMPTS) {
        await this.failScan(scan, attempts, state);
        continue;
      }

      this.logger.warn(
        `Re-enqueueing orphaned ${scan.status} scan ${scan.id} (job state: ${state ?? 'none'})`,
      );
      try {
        // Clear any lingering terminal job so the deterministic id is free,
        // reset to PENDING, then re-enqueue (processing is idempotent). The
        // write is guarded by the status read above: a scan canceled or
        // picked up since then is left alone.
        await this.scanQueueService.cancelScanJob(scan.id);
        const result = await this.scanRepository.update(
          { id: scan.id, status: scan.status },
          { status: ScanStatus.PENDING, reconcileAttempts: attempts + 1 },
        );
        if (!result.affected) {
          this.logger.log(
            `Scan ${scan.id} changed status during reconciliation; not re-enqueued`,
          );
          continue;
        }
        await this.scanQueueService.addScanJob(scan.id);
      } catch (error) {
        this.logger.error(
          `Failed to re-enqueue scan ${scan.id}: ${String(error)}`,
        );
      }
    }
  }

  /**
   * Marks an orphaned scan FAILED after its last re-enqueue was lost too, and
   * clears its lingering job. Guarded like a re-enqueue: a scan whose status
   * changed since it was read is left alone.
   */
  private async failScan(
    scan: Pick<Scan, 'id' | 'status'>,
    attempts: number,
    state: string | null,
  ): Promise<void> {
    try {
      const result = await this.scanRepository.update(
        { id: scan.id, status: scan.status },
        { status: ScanStatus.FAILED },
      );
      if (!result.affected) {
        return;
      }
      this.logger.error(
        `Failing orphaned ${scan.status} scan ${scan.id}: its job was lost again after ${attempts} re-enqueues (job state: ${state ?? 'none'})`,
      );
      await this.scanQueueService.cancelScanJob(scan.id);
    } catch (error) {
      this.logger.error(`Failed to fail scan ${scan.id}: ${String(error)}`);
    }
  }
}
