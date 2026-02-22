import { ApiProperty } from '@nestjs/swagger';

/**
 * Runtime counters describing scan processing progress.
 */
export class ScanProgressResponseDto {
  /** Number of unique pages discovered so far for the run. */
  @ApiProperty({
    type: 'integer',
    example: 120,
    minimum: 0,
    description: 'Number of unique pages discovered for this run.',
  })
  pagesDiscovered: number;

  /** Number of pages analyzed successfully. */
  @ApiProperty({
    type: 'integer',
    example: 100,
    minimum: 0,
    description: 'Number of pages successfully analyzed.',
  })
  pagesScanned: number;

  /** Number of pages that failed processing. */
  @ApiProperty({
    type: 'integer',
    example: 3,
    minimum: 0,
    description: 'Number of pages that failed during processing.',
  })
  pagesFailed: number;
}
