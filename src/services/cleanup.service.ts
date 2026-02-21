import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { Scan } from '../entities/scan.entity';

/**
 * Service for automated cleanup of old scan data.
 *
 * Configuration via environment variables:
 * - CLEANUP_ENABLED: Enable/disable automatic cleanup (default: true)
 * - CLEANUP_INTERVAL: Cron expression for schedule (default: daily at 2 AM)
 * - CLEANUP_RETENTION_DAYS: Days to retain scans (default: 30)
 */
@Injectable()
export class CleanupService {
  private readonly logger = new Logger(CleanupService.name);
  private readonly isEnabled: boolean;
  private readonly retentionDays: number;

  constructor(
    @InjectRepository(Scan)
    private readonly scanRepository: Repository<Scan>,
  ) {
    this.isEnabled = process.env.CLEANUP_ENABLED !== 'false';
    this.retentionDays = parseInt(process.env.CLEANUP_RETENTION_DAYS || '30');

    this.logger.log(
      `Cleanup service initialized - enabled: ${this.isEnabled}, retention: ${this.retentionDays} days`,
    );
  }

  @Cron(process.env.CLEANUP_INTERVAL || CronExpression.EVERY_DAY_AT_2AM)
  async performScheduledCleanup(): Promise<void> {
    if (!this.isEnabled) {
      return;
    }

    this.logger.log('Starting scheduled cleanup');
    await this.performCleanup();
    this.logger.log('Scheduled cleanup completed');
  }

  async performCleanup(): Promise<void> {
    const cutoffDate = new Date();

    if (this.retentionDays === 0) {
      cutoffDate.setTime(cutoffDate.getTime() + 60 * 1000);
    } else {
      cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);
    }

    this.logger.log(`Cleaning up scans older than ${cutoffDate.toISOString()}`);

    const scans = await this.scanRepository.find({
      where: { createdAt: LessThan(cutoffDate) },
      select: ['id'],
    });

    if (scans.length === 0) {
      this.logger.log('No scans found for cleanup');
      return;
    }

    const scanIds = scans.map((s) => s.id);
    const result = await this.scanRepository.delete(scanIds);
    this.logger.log(`Removed ${result.affected ?? scans.length} scans`);
  }

  async triggerManualCleanup(): Promise<void> {
    this.logger.log('Manual cleanup triggered');
    await this.performCleanup();
  }

  getCleanupConfig(): {
    enabled: boolean;
    retentionDays: number;
    interval: string;
  } {
    return {
      enabled: this.isEnabled,
      retentionDays: this.retentionDays,
      interval: process.env.CLEANUP_INTERVAL || CronExpression.EVERY_DAY_AT_2AM,
    };
  }
}
