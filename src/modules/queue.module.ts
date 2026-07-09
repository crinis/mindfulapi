import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { redisConfig } from '../config/configuration';
import { ScanProcessor } from '../services/scan.processor';
import {
  ScanQueueService,
  SCAN_QUEUE_NAME,
} from '../services/scan-queue.service';
import { ScanReconciliationService } from '../services/scan-reconciliation.service';
import { BrowserService } from '../services/browser.service';
import { AxeAccessibilityScanner } from '../services/axe-accessibility-scanner.service';
import { BasicAuthCryptoService } from '../services/basic-auth-crypto.service';
import { UrlPolicyService } from '../services/url-policy.service';
import { Scan } from '../entities/scan.entity';
import { Issue } from '../entities/issue.entity';
import { AgentModule } from './agent.module';

/**
 * Infrastructure module configuring BullMQ workers and shared scan-processing services.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [redisConfig.KEY],
      useFactory: (redis: ConfigType<typeof redisConfig>) => ({
        connection: {
          host: redis.host,
          port: redis.port,
          password: redis.password,
        },
      }),
    }),
    BullModule.registerQueue({
      name: SCAN_QUEUE_NAME,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 10,
        removeOnFail: 5,
      },
    }),
    TypeOrmModule.forFeature([Scan, Issue]),
    AgentModule,
  ],
  providers: [
    ScanProcessor,
    ScanQueueService,
    ScanReconciliationService,
    BrowserService,
    AxeAccessibilityScanner,
    BasicAuthCryptoService,
    UrlPolicyService,
  ],
  exports: [
    ScanQueueService,
    BrowserService,
    BasicAuthCryptoService,
    UrlPolicyService,
  ],
})
export class QueueModule {}
