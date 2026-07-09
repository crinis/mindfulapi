import { Controller, Post, Get, HttpCode, HttpStatus } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { CleanupService } from '../services/cleanup.service';
import { CleanupConfigDto, CleanupResultDto } from '../dto/cleanup.dto';
import { ApiProblemResponses } from '../decorators/api-problem-responses.decorator';

/**
 * Controller for cleanup operations.
 * @route /cleanup
 */
@ApiTags('Cleanup')
@ApiBearerAuth()
@Controller('cleanup')
export class CleanupController {
  /**
   * @param cleanupService Service handling scheduled/manual cleanup logic.
   */
  constructor(private readonly cleanupService: CleanupService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'triggerCleanup',
    summary: 'Trigger manual cleanup',
    description:
      'Immediately runs the cleanup process to delete scans older than the configured retention period, bypassing the enabled flag.',
  })
  @ApiResponse({
    status: 200,
    description: 'Cleanup completed',
    type: CleanupResultDto,
  })
  @ApiProblemResponses(401, 429, 500)
  /**
   * Triggers immediate cleanup and returns the number of scans deleted.
   */
  async triggerCleanup(): Promise<CleanupResultDto> {
    const { deletedScans, cutoffDate } =
      await this.cleanupService.triggerManualCleanup();
    return { deletedScans, cutoffDate: cutoffDate.toISOString() };
  }

  @Get('policy')
  @ApiOperation({
    operationId: 'getCleanupPolicy',
    summary: 'Get cleanup retention policy',
    description:
      'Returns the current cleanup retention policy derived from environment variables.',
  })
  @ApiResponse({
    status: 200,
    description: 'Cleanup retention policy',
    type: CleanupConfigDto,
  })
  @ApiProblemResponses(401, 429, 500)
  /**
   * Returns the active cleanup retention policy.
   */
  getCleanupPolicy(): CleanupConfigDto {
    return this.cleanupService.getCleanupConfig();
  }
}
