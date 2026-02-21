import { ApiProperty } from '@nestjs/swagger';

/**
 * Runtime counters describing scan processing progress.
 */
export class ScanProgressResponseDto {
  /** Number of unique pages discovered so far for the run. */
  @ApiProperty({
    example: 120,
    minimum: 0,
    description: 'Number of unique pages discovered for this run.',
  })
  pagesDiscovered: number;

  /** Number of pages analyzed successfully. */
  @ApiProperty({
    example: 100,
    minimum: 0,
    description: 'Number of pages successfully analyzed.',
  })
  pagesScanned: number;

  /** Number of pages that failed processing. */
  @ApiProperty({
    example: 3,
    minimum: 0,
    description: 'Number of pages that failed during processing.',
  })
  pagesFailed: number;
}
