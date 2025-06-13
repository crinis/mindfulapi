import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScanModule } from './modules/scan.module';
import { QueueModule } from './modules/queue.module';
import { CleanupModule } from './modules/cleanup.module';
import { Scan } from './entities/scan.entity';
import { Issue } from './entities/issue.entity';
import { authProvider } from './guards/auth-provider';

/**
 * Root application module that configures database connection and imports feature modules.
 * 
 * Configures SQLite database with TypeORM for development and testing environments.
 * Database synchronization and logging are enabled in non-production environments
 * for easier development and debugging.
 */
@Module({
  imports: [
    // Configure TypeORM with SQLite for simplicity in development
    TypeOrmModule.forRoot({
      type: 'sqlite',
      database: 'database.sqlite',
      entities: [Scan, Issue],
      // Auto-sync database schema in development (disable in production)
      synchronize: process.env.NODE_ENV !== 'production',
      // Enable SQL logging in development for debugging
      logging: process.env.NODE_ENV !== 'production',
    }),
    QueueModule, // Background job processing for accessibility scans
    ScanModule, // Core scan management functionality
    CleanupModule, // Automated cleanup of old scans and screenshots
  ],
  providers: [authProvider],
})
export class AppModule {}
