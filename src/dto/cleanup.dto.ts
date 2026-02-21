import { ApiProperty } from '@nestjs/swagger';

/**
 * Generic message response returned from action endpoints (e.g. trigger cleanup).
 */
export class MessageDto {
  @ApiProperty({ example: 'Cleanup completed successfully' })
  message: string;
}

/**
 * Cleanup service configuration as derived from environment variables.
 */
export class CleanupConfigDto {
  @ApiProperty({
    example: true,
    description: 'Whether scheduled automatic cleanup is enabled',
  })
  enabled: boolean;

  @ApiProperty({
    example: 30,
    description: 'Number of days to retain scans before deletion',
  })
  retentionDays: number;

  @ApiProperty({
    example: '0 2 * * *',
    description: 'Cron expression controlling the cleanup schedule',
  })
  interval: string;
}
