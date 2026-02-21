import { Controller, Post, Get, HttpCode, HttpStatus } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { CleanupService } from '../services/cleanup.service';
import { CleanupConfigDto, MessageDto } from '../dto/cleanup.dto';
import { ErrorResponseDto } from '../dto/error-response.dto';

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
    type: MessageDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid Bearer token',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 500,
    description: 'Unexpected server error',
    type: ErrorResponseDto,
  })
  /**
   * Triggers immediate cleanup and returns a success message payload.
   */
  async triggerCleanup(): Promise<MessageDto> {
    await this.cleanupService.triggerManualCleanup();
    return { message: 'Cleanup completed successfully' };
  }

  @Get('config')
  @ApiOperation({
    operationId: 'getCleanupConfig',
    summary: 'Get cleanup configuration',
    description:
      'Returns the current cleanup configuration derived from environment variables.',
  })
  @ApiResponse({
    status: 200,
    description: 'Cleanup configuration',
    type: CleanupConfigDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid Bearer token',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 500,
    description: 'Unexpected server error',
    type: ErrorResponseDto,
  })
  /**
   * Returns active cleanup configuration values.
   */
  getCleanupConfig(): CleanupConfigDto {
    return this.cleanupService.getCleanupConfig();
  }
}
