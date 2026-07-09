import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BrowserService } from './browser.service';
import { ScanQueueService } from './scan-queue.service';
import { HealthResponseDto } from '../dto/health-response.dto';

/**
 * Hand-rolled health/readiness aggregation. Pings the database and Redis,
 * reports browser connectivity, and includes queue depth counters.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly scanQueueService: ScanQueueService,
    private readonly browserService: BrowserService,
  ) {}

  /**
   * Runs all health checks and aggregates the result.
   *
   * @returns The health report; `status` is `error` if a required dependency
   *   (database or Redis) is down.
   */
  async check(): Promise<HealthResponseDto> {
    const database = await this.pingDatabase();
    const { redis, queue } = await this.pingQueue();
    const browserConnected = this.browserService.isConnected();

    const status = database === 'up' && redis === 'up' ? 'ok' : 'error';

    return {
      status,
      checks: { database, redis, browserConnected, queue },
    };
  }

  /**
   * Runs a trivial query to confirm the database is reachable.
   */
  private async pingDatabase(): Promise<'up' | 'down'> {
    try {
      await this.dataSource.query('SELECT 1');
      return 'up';
    } catch (error) {
      this.logger.warn(`Database health check failed: ${String(error)}`);
      return 'down';
    }
  }

  /**
   * Confirms Redis is reachable and collects queue depth counters.
   */
  private async pingQueue(): Promise<{
    redis: 'up' | 'down';
    queue: HealthResponseDto['checks']['queue'];
  }> {
    try {
      const queue = await this.scanQueueService.getQueueStatus();
      return { redis: 'up', queue };
    } catch (error) {
      this.logger.warn(`Redis/queue health check failed: ${String(error)}`);
      return { redis: 'down', queue: null };
    }
  }
}
