import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScanModule } from './modules/scan.module';
import { QueueModule } from './modules/queue.module';
import { CleanupModule } from './modules/cleanup.module';
import { authProvider } from './guards/auth-provider';
import { createDatabaseConfig } from './config/database.config';
import { validate } from './config/env.validation';
import {
  appConfig,
  cleanupConfig,
  databaseConfig,
  redisConfig,
  scanConfig,
  securityConfig,
} from './config/configuration';

/**
 * Root application module wiring validated configuration, persistence,
 * queue processing, cleanup, and the global auth guard.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate,
      load: [
        appConfig,
        securityConfig,
        redisConfig,
        databaseConfig,
        scanConfig,
        cleanupConfig,
      ],
    }),
    TypeOrmModule.forRootAsync({
      inject: [databaseConfig.KEY],
      useFactory: (database: ConfigType<typeof databaseConfig>) =>
        createDatabaseConfig(database),
    }),
    ThrottlerModule.forRootAsync({
      inject: [securityConfig.KEY],
      useFactory: (security: ConfigType<typeof securityConfig>) => ({
        throttlers: [
          {
            ttl: security.throttleTtlSeconds * 1000,
            limit: security.throttleLimit,
          },
        ],
      }),
    }),
    QueueModule, // Background job processing for accessibility scans
    ScanModule, // Core scan management functionality
    CleanupModule, // Automated cleanup of old scan data
  ],
  providers: [authProvider, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
