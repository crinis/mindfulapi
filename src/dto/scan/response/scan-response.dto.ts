import { ApiProperty } from '@nestjs/swagger';
import { ScanStatus } from '../../../enums/scan-status.enum';
import { ScanMode } from '../../../enums/scan-mode.enum';
import { CrawlOptionsResponseDto } from './crawl-options-response.dto';
import { ScanProgressResponseDto } from './scan-progress-response.dto';
import { ScanOptionsResponseDto } from './scan-options-response.dto';
import { ViolationResponseDto } from './violation-response.dto';

/**
 * Unified API response representing a scan run and its results/progress.
 */
export class ScanResponseDto {
  /** Stable numeric identifier of the scan run. */
  @ApiProperty({
    type: 'integer',
    example: 1,
    minimum: 1,
    description: 'Unique scan run identifier.',
  })
  id: number;

  /** Mode that defined how pages were selected for this run. */
  @ApiProperty({ enum: ScanMode, example: ScanMode.CRAWL })
  mode: ScanMode;

  /** Normalized target URLs or crawl seed URLs used for this run. */
  @ApiProperty({
    example: ['https://example.com'],
    type: 'array',
    items: { type: 'string', format: 'uri' },
    uniqueItems: true,
    minItems: 1,
    description: 'Input URL targets or crawl seeds for this run.',
  })
  targets: string[];

  /** Current lifecycle status of the scan run. */
  @ApiProperty({ enum: ScanStatus, example: ScanStatus.COMPLETED })
  status: ScanStatus;

  /** Effective scan options applied to every analyzed page. */
  @ApiProperty({ type: () => ScanOptionsResponseDto })
  scanOptions: ScanOptionsResponseDto;

  /** Effective crawl options when run mode is crawl; `null` for other modes. */
  @ApiProperty({
    type: () => CrawlOptionsResponseDto,
    nullable: true,
    description: 'Present only for crawl runs.',
  })
  crawlOptions: CrawlOptionsResponseDto | null;

  /** Progress counters for discovered/scanned/failed pages. */
  @ApiProperty({
    type: () => ScanProgressResponseDto,
    description: 'Runtime page-processing counters for this run.',
  })
  progress: ScanProgressResponseDto;

  /** Violations grouped by rule identifier and impact severity. */
  @ApiProperty({
    type: () => ViolationResponseDto,
    isArray: true,
    description:
      'Accessibility violations grouped by rule and impact severity.',
  })
  violations: ViolationResponseDto[];

  /** Total number of issue occurrences across all grouped violations. */
  @ApiProperty({
    type: 'integer',
    example: 3,
    minimum: 0,
    description: 'Sum of issue occurrences across all violations.',
  })
  totalIssueCount: number;

  /** Timestamp indicating when this scan run record was created. */
  @ApiProperty({
    example: '2025-06-14T10:30:00.000Z',
    type: 'string',
    format: 'date-time',
    description: 'Timestamp when this run was created.',
  })
  createdAt: Date;

  /** Timestamp of the most recent update to this scan run record. */
  @ApiProperty({
    example: '2025-06-14T10:31:00.000Z',
    type: 'string',
    format: 'date-time',
    description: 'Timestamp when this run was last updated.',
  })
  updatedAt: Date;
}
