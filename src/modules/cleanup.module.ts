import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { CleanupService } from '../services/cleanup.service';
import { CleanupController } from '../controllers/cleanup.controller';
import { Scan } from '../entities/scan.entity';

/**
 * Feature module for scheduled/manual cleanup operations and cleanup API endpoints.
 */
@Module({
  imports: [ScheduleModule.forRoot(), TypeOrmModule.forFeature([Scan])],
  controllers: [CleanupController],
  providers: [CleanupService],
  exports: [CleanupService],
})
export class CleanupModule {}
