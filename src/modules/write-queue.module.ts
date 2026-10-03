import { Global, Module } from '@nestjs/common';
import { WriteQueue } from '../services/write-queue.service';

/**
 * Provides the one process-wide {@link WriteQueue} to every module: the AI
 * audit and the scan processor must share a single instance.
 */
@Global()
@Module({
  providers: [WriteQueue],
  exports: [WriteQueue],
})
export class WriteQueueModule {}
