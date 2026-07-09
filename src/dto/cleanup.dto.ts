import { ApiProperty } from '@nestjs/swagger';

/**
 * Result of a manual cleanup run.
 */
export class CleanupResultDto {
  /** Number of scan runs deleted by this cleanup. */
  @ApiProperty({
    type: 'integer',
    example: 12,
    description: 'Number of scan runs deleted.',
    minimum: 0,
  })
  deletedScans: number;

  /** ISO 8601 cutoff — scans created before this were deleted. */
  @ApiProperty({
    example: '2026-06-09T00:00:00.000Z',
    description: 'Scans created before this timestamp were deleted.',
    format: 'date-time',
  })
  cutoffDate: string;
}

/**
 * Cleanup retention policy as derived from environment variables.
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
