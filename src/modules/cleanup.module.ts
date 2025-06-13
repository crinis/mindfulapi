import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { CleanupService } from '../services/cleanup.service';
import { CleanupController } from '../controllers/cleanup.controller';
import { Scan } from '../entities/scan.entity';
import { Issue } from '../entities/issue.entity';

/**
 * Cleanup module for automated data retention and file management.
 * 
 * This module provides automated cleanup functionality for the accessibility
 * scanning application. It handles scheduled removal of old scans, their
 * associated issues, and orphaned screenshot files to maintain optimal
 * system performance and storage usage.
 * 
 * Features:
 * - Scheduled cleanup jobs using NestJS scheduler
 * - Configurable retention periods via environment variables
 * - Database cascade deletion for scans and issues
 * - Screenshot file cleanup from filesystem
 * - Manual cleanup triggers for administrative control
 * 
 * The module integrates with:
 * - ScheduleModule: For cron-based job scheduling
 * - TypeOrmModule: For database operations on Scan and Issue entities
 * 
 * Configuration is managed through environment variables:
 * - CLEANUP_ENABLED: Enable/disable automatic cleanup
 * - CLEANUP_INTERVAL: Cron expression for cleanup schedule
 * - CLEANUP_RETENTION_DAYS: Days to retain data before cleanup
 * - SCREENSHOT_DIR: Directory containing screenshot files
 */
@Module({
  imports: [
    // Enable NestJS scheduler for cron jobs
    ScheduleModule.forRoot(),
    // Import required entities for database operations
    TypeOrmModule.forFeature([Scan, Issue]),
  ],
  controllers: [CleanupController],
  providers: [CleanupService],
  exports: [CleanupService],
})
export class CleanupModule {}
