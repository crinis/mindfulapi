import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScanProcessor } from '../services/scan.processor';
import { ScanQueueService } from '../services/scan-queue.service';
import { BrowserService } from '../services/browser.service';
import { AxeAccessibilityScanner } from '../services/axe-accessibility-scanner.service';
import { BasicAuthCryptoService } from '../services/basic-auth-crypto.service';
import { Scan } from '../entities/scan.entity';
import { Issue } from '../entities/issue.entity';

/**
 * Infrastructure module configuring BullMQ workers and shared scan-processing services.
 */
@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD,
      },
    }),
    BullModule.registerQueue({
      name: 'scan-processing',
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
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
    AxeAccessibilityScanner,
    BasicAuthCryptoService,
  ],
  exports: [ScanQueueService, BrowserService, BasicAuthCryptoService],
})
export class QueueModule {}
