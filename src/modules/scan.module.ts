import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Scan } from '../entities/scan.entity';
import { ScanService } from '../services/scan.service';
import { ScanController } from '../controllers/scan.controller';
import { RulesController } from '../controllers/rules.controller';
import { RulesService } from '../services/rules.service';
import { QueueModule } from './queue.module';

/**
 * Feature module exposing scan and rules HTTP APIs with scan orchestration services.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Scan]), QueueModule],
  controllers: [ScanController, RulesController],
  providers: [ScanService, RulesService],
  exports: [ScanService],
})
export class ScanModule {}
