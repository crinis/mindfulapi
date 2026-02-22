import { ApiProperty } from '@nestjs/swagger';

/**
 * Generic message response returned from action endpoints (e.g. trigger cleanup).
 */
export class MessageDto {
  /** Human-readable result message for the invoked operation. */
  @ApiProperty({
    example: 'Cleanup completed successfully',
    description: 'Human-readable operation result message.',
  })
  message: string;
}

/**
 * Cleanup service configuration as derived from environment variables.
 */
export class CleanupConfigDto {
  /** Indicates whether scheduled cleanup executions are active. */
  @ApiProperty({
    example: true,
    description: 'Whether scheduled automatic cleanup is enabled',
  })
  enabled: boolean;

  /** Number of days scan data is retained before deletion. */
  @ApiProperty({
    type: 'integer',
    example: 30,
    description: 'Number of days to retain scans before deletion',
    minimum: 1,
  })
  retentionDays: number;

  /** Cron expression that controls scheduled cleanup frequency. */
  @ApiProperty({
    example: '0 2 * * *',
    description: 'Cron expression controlling the cleanup schedule',
  })
  interval: string;
}
