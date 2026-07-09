import { ApiProperty } from '@nestjs/swagger';
import { ScanStatus } from '../../../enums/scan-status.enum';
import { ScanMode } from '../../../enums/scan-mode.enum';
import { CrawlOptionsResponseDto } from './crawl-options-response.dto';
import { ScanProgressResponseDto } from './scan-progress-response.dto';
import { ScanOptionsResponseDto } from './scan-options-response.dto';
import { AiAuditResponseDto } from './ai-audit-response.dto';

/**
 * Issue occurrence counts grouped by severity.
 */
export class IssueCountsDto {
  /** Number of critical-impact issue occurrences. */
  @ApiProperty({ type: 'integer', example: 1, minimum: 0 })
  critical: number;

  /** Number of serious-impact issue occurrences. */
  @ApiProperty({ type: 'integer', example: 2, minimum: 0 })
  serious: number;

  /** Number of moderate-impact issue occurrences. */
  @ApiProperty({ type: 'integer', example: 0, minimum: 0 })
  moderate: number;

  /** Number of minor-impact issue occurrences. */
  @ApiProperty({ type: 'integer', example: 0, minimum: 0 })
  minor: number;
}

/**
 * Lightweight scan representation for list endpoints. Unlike
 * {@link ScanResponseDto} it omits the (potentially large) grouped
 * `violations` array, exposing per-severity counts instead.
 */
export class ScanSummaryResponseDto {
  /** Stable numeric identifier of the scan run. */
  @ApiProperty({ type: 'integer', example: 1, minimum: 1 })
  id: number;

  /** Mode that defined how pages were selected for this run. */
  @ApiProperty({ enum: ScanMode, example: ScanMode.CRAWL })
  mode: ScanMode;

  /** Normalized target URLs or crawl seed URLs used for this run. */
  @ApiProperty({
    example: ['https://example.com'],
    type: 'array',
    items: { type: 'string', format: 'uri' },
  })
  targets: string[];

  /** Current lifecycle status of the scan run. */
  @ApiProperty({ enum: ScanStatus, example: ScanStatus.COMPLETED })
  status: ScanStatus;

  /** Effective scan options applied to every analyzed page. */
  @ApiProperty({ type: () => ScanOptionsResponseDto })
  scanOptions: ScanOptionsResponseDto;

  /** Effective crawl options when run mode is crawl; `null` for other modes. */
  @ApiProperty({ type: () => CrawlOptionsResponseDto, nullable: true })
  crawlOptions: CrawlOptionsResponseDto | null;

  /** Progress counters for discovered/scanned/failed pages. */
  @ApiProperty({ type: () => ScanProgressResponseDto })
  progress: ScanProgressResponseDto;

  /** Issue occurrence counts grouped by severity. */
  @ApiProperty({ type: () => IssueCountsDto })
  issueCounts: IssueCountsDto;

  /** Total number of issue occurrences across all severities. */
  @ApiProperty({ type: 'integer', example: 3, minimum: 0 })
  totalIssueCount: number;

  /** Optional AI-audit phase summary; `null` when not requested/enabled. */
  @ApiProperty({ type: () => AiAuditResponseDto, nullable: true })
  aiAudit: AiAuditResponseDto | null;

  /** Number of agent findings produced by the AI-audit phase. */
  @ApiProperty({ type: 'integer', example: 2, minimum: 0 })
  agentFindingCount: number;

  /** Timestamp indicating when this scan run record was created. */
  @ApiProperty({
    example: '2025-06-14T10:30:00.000Z',
    type: 'string',
    format: 'date-time',
  })
  createdAt: Date;

  /** Timestamp of the most recent update to this scan run record. */
  @ApiProperty({
    example: '2025-06-14T10:31:00.000Z',
    type: 'string',
    format: 'date-time',
  })
  updatedAt: Date;
}
