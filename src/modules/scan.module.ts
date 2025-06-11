import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Scan } from '../entities/scan.entity';
import { ScanService } from '../services/scan.service';
import { ScanController } from '../controllers/scan.controller';
import { QueueModule } from './queue.module';
import { RuleService } from '../services/rule.service';

/**
 * Scan module providing accessibility scanning functionality and REST API endpoints.
 * 
 * This module encapsulates all components necessary for managing accessibility scans,
 * including scan creation, status tracking, result retrieval, and rule-based help
 * URL generation. It integrates with the queue system for asynchronous processing
 * and provides comprehensive scan management capabilities.
 * 
 * Module components:
 * - ScanController: REST API endpoints for scan operations
 * - ScanService: Core business logic for scan management and data processing
 * - RuleService: WCAG technique URL generation for accessibility guidance
 * - Scan entity: Database model for scan persistence
 * 
 * Dependencies:
 * - QueueModule: For asynchronous scan job processing
 * - TypeORM: For database operations and entity management
 * 
 * The module exports ScanService to enable integration with other application
 * modules that need access to scan functionality.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Scan]), QueueModule],
  controllers: [ScanController],
  providers: [ScanService, RuleService],
  exports: [ScanService],
})
export class ScanModule {}
