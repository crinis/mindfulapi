import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScanModule } from './modules/scan.module';
import { QueueModule } from './modules/queue.module';
import { CleanupModule } from './modules/cleanup.module';
import { authProvider } from './guards/auth-provider';
import { createDatabaseConfig } from './config/database.config';

/**
 * Root application module that configures database connection and imports feature modules.
 * 
 * Configures SQLite database with TypeORM for development and testing environments.
 * Database synchronization and logging are enabled in non-production environments
 * for easier development and debugging.
 */
@Module({
  imports: [
    // Configure TypeORM with shared configuration
    TypeOrmModule.forRoot(createDatabaseConfig()),
    QueueModule, // Background job processing for accessibility scans
    ScanModule, // Core scan management functionality
    CleanupModule, // Automated cleanup of old scans and screenshots
  ],
  providers: [authProvider],
})
export class AppModule {}
