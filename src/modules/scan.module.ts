import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Scan } from '../entities/scan.entity';
import { Issue } from '../entities/issue.entity';
import { AgentFinding } from '../entities/agent-finding.entity';
import { ScanService } from '../services/scan.service';
import { ScanController } from '../controllers/scan.controller';
import { RulesController } from '../controllers/rules.controller';
import { RulesService } from '../services/rules.service';
import { QueueModule } from './queue.module';
import { ReportController } from '../controllers/report.controller';
import { ReportService } from '../services/report.service';

/**
 * Feature module exposing scan and rules HTTP APIs with scan orchestration services.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Scan, Issue, AgentFinding]), QueueModule],
  controllers: [ScanController, RulesController, ReportController],
  providers: [ScanService, RulesService, ReportService],
  exports: [ScanService],
})
export class ScanModule {}
