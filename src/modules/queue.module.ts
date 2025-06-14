import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ScanProcessor } from '../services/scan.processor';
import { ScanQueueService } from '../services/scan-queue.service';
import { BrowserService } from '../services/browser.service';
import { HtmlcsAccessibilityScanner } from '../services/htmlcs-accessibility-scanner.service';
import { AxeAccessibilityScanner } from '../services/axe-accessibility-scanner.service';
import { BaseAccessibilityScanner } from '../services/base-accessibility-scanner.service';
import { AccessibilityScannerFactory } from '../services/accessibility-scanner-factory.service';
import { RuleService } from '../services/rule.service';
import { AxeRuleService } from '../services/axe-rule.service';
import { RuleServiceFactory } from '../services/rule-service-factory.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Scan } from '../entities/scan.entity';
import { Issue } from '../entities/issue.entity';

/**
 * Queue module for asynchronous accessibility scan processing with BullMQ and Redis.
 * 
 * This module provides the complete infrastructure for background processing of
 * accessibility scans using BullMQ job queues backed by Redis. It handles job
 * scheduling, processing, retry logic, and resource management for reliable
 * scan execution at scale.
 * 
 * Key features:
 * - Redis-backed job queue for persistent job storage
 * - Exponential backoff retry mechanism for failed scans
 * - Automatic job cleanup to prevent queue bloat
 * - Browser instance management for scan automation
 * - HTML_CodeSniffer integration for accessibility analysis
 * 
 * Queue configuration:
 * - 3 retry attempts with exponential backoff (2s base delay)
 * - Retains 10 completed jobs and 5 failed jobs for monitoring
 * - Configurable Redis connection via environment variables
 * 
 * Module components:
 * - ScanProcessor: Background job processor for scan execution
 * - ScanQueueService: Job queuing and status monitoring interface
 * - BrowserService: Shared Chromium instance management
 * - HtmlcsAccessibilityScanner: Accessibility scanning implementation
 * 
 * The module integrates with TypeORM for database operations and exports
 * ScanQueueService for use by other application modules.
 */
@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD,
      },
    }),
    BullModule.registerQueue({
      name: 'scan-processing',
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: 10,
        removeOnFail: 5,
      },
    }),
    TypeOrmModule.forFeature([Scan, Issue]),
  ],
  providers: [
    ScanProcessor,
    ScanQueueService,
    BrowserService,
    HtmlcsAccessibilityScanner,
    AxeAccessibilityScanner,
    AccessibilityScannerFactory,
    RuleService,
    AxeRuleService,
    RuleServiceFactory,
  ],
  exports: [ScanQueueService],
})
export class QueueModule {}
