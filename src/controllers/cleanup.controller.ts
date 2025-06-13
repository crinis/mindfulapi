import { Controller, Post, Get, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { CleanupService } from '../services/cleanup.service';
import { AuthTokenGuard } from '../guards/auth-token.guard';

/**
 * Administrative controller for cleanup operations.
 * 
 * This controller provides administrative endpoints for managing the cleanup
 * service, including manual cleanup triggers and configuration inspection.
 * All endpoints are protected by authentication to prevent unauthorized access
 * to administrative functions.
 * 
 * @route /admin/cleanup
 */
@Controller('admin/cleanup')
@UseGuards(AuthTokenGuard)
export class CleanupController {
  constructor(private readonly cleanupService: CleanupService) {}

  /**
   * Manually trigger cleanup process.
   * 
   * This endpoint allows administrators to trigger cleanup manually without
   * waiting for the scheduled job. Useful for maintenance, testing, or when
   * immediate cleanup is required.
   * 
   * @returns Success message when cleanup completes
   */
  @Post('trigger')
  @HttpCode(HttpStatus.OK)
  async triggerCleanup(): Promise<{ message: string }> {
    await this.cleanupService.triggerManualCleanup();
    return { message: 'Cleanup completed successfully' };
  }

  /**
   * Get current cleanup configuration.
   * 
   * Returns the current cleanup service configuration including retention
   * period, schedule, enabled status, and performance tuning parameters
   * for monitoring and verification.
   * 
   * @returns Object containing cleanup configuration
   */
  @Get('config')
  getCleanupConfig(): {
    enabled: boolean;
    retentionDays: number;
    screenshotDir: string;
    interval: string;
    batchSize: number;
    concurrencyLimit: number;
  } {
    return this.cleanupService.getCleanupConfig();
  }
}
