import { ApiProperty } from '@nestjs/swagger';

/** Health state of a single dependency. */
export type DependencyStatus = 'up' | 'down';

/** Queue depth counters surfaced for operational visibility. */
export class QueueCountsDto {
  @ApiProperty({ type: 'integer', example: 0, minimum: 0 })
  waiting: number;

  @ApiProperty({ type: 'integer', example: 1, minimum: 0 })
  active: number;

  @ApiProperty({ type: 'integer', example: 42, minimum: 0 })
  completed: number;

  @ApiProperty({ type: 'integer', example: 0, minimum: 0 })
  failed: number;
}

/** Per-dependency health details. */
export class HealthChecksDto {
  /** SQLite database connectivity. */
  @ApiProperty({ enum: ['up', 'down'], example: 'up' })
  database: DependencyStatus;

  /** Redis / BullMQ connectivity. */
  @ApiProperty({ enum: ['up', 'down'], example: 'up' })
  redis: DependencyStatus;

  /** Whether a browser is currently connected (informational, not required). */
  @ApiProperty({ example: true })
  browserConnected: boolean;

  /** Queue depth counters (present when Redis is up). */
  @ApiProperty({ type: () => QueueCountsDto, nullable: true })
  queue: QueueCountsDto | null;
}

/**
 * Aggregate health/readiness response.
 */
export class HealthResponseDto {
  /** Overall status: `ok` when required dependencies are up, else `error`. */
  @ApiProperty({ enum: ['ok', 'error'], example: 'ok' })
  status: 'ok' | 'error';

  /** Per-dependency detail. */
  @ApiProperty({ type: () => HealthChecksDto })
  checks: HealthChecksDto;
}
