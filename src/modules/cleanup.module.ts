import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CleanupService } from '../services/cleanup.service';
import { CleanupController } from '../controllers/cleanup.controller';
import { Scan } from '../entities/scan.entity';

/**
 * Feature module for scheduled/manual cleanup operations and cleanup API endpoints.
 * ScheduleModule.forRoot() is registered once in AppModule.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Scan])],
  controllers: [CleanupController],
  providers: [CleanupService],
  exports: [CleanupService],
})
export class CleanupModule {}
