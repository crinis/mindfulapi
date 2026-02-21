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
  constructor(private readonly cleanupService: CleanupService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
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
  async triggerCleanup(): Promise<MessageDto> {
    await this.cleanupService.triggerManualCleanup();
    return { message: 'Cleanup completed successfully' };
  }

  @Get('config')
  @ApiOperation({
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
  getCleanupConfig(): CleanupConfigDto {
    return this.cleanupService.getCleanupConfig();
  }
}
