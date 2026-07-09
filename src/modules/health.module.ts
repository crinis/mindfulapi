import { Module } from '@nestjs/common';
import { HealthController } from '../controllers/health.controller';
import { HealthService } from '../services/health.service';
import { QueueModule } from './queue.module';

/**
 * Exposes the unauthenticated /health probe. Depends on QueueModule for the
 * queue and browser services.
 */
@Module({
  imports: [QueueModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
