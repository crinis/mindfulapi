import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Scan } from '../entities/scan.entity';
import { ScanService } from '../services/scan.service';
import { ScanController } from '../controllers/scan.controller';
import { RulesController } from '../controllers/rules.controller';
import { QueueModule } from './queue.module';
import { HtmlcsRuleService } from '../services/htmlcs-rule.service';
import { AxeRuleService } from '../services/axe-rule.service';
import { RuleServiceFactory } from '../services/rule-service-factory.service';
import { RulesService } from '../services/rules.service';
import { AccessibilityScannerFactory } from '../services/accessibility-scanner-factory.service';
import { HtmlcsAccessibilityScanner } from '../services/htmlcs-accessibility-scanner.service';
import { AxeAccessibilityScanner } from '../services/axe-accessibility-scanner.service';

/**
 * Scan module providing accessibility scanning functionality and REST API endpoints.
 * 
 * This module encapsulates all components necessary for managing accessibility scans,
 * including scan creation, status tracking, result retrieval, rule discovery, and
 * rule-based help URL generation. It integrates with the queue system for asynchronous
 * processing and provides comprehensive scan management capabilities.
 * 
 * Module components:
 * - ScanController: REST API endpoints for scan operations
 * - RulesController: REST API endpoints for rule discovery
 * - ScanService: Core business logic for scan management and data processing
 * - RulesService: Rule discovery and metadata for different scanner types
 * - HtmlcsRuleService: WCAG technique URL generation for HTMLCS accessibility guidance
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
  controllers: [ScanController, RulesController],
  providers: [
    ScanService,
    RulesService,
    HtmlcsRuleService,
    AxeRuleService,
    RuleServiceFactory,
    AccessibilityScannerFactory,
    HtmlcsAccessibilityScanner,
    AxeAccessibilityScanner,
  ],
  exports: [ScanService],
})
export class ScanModule {}
