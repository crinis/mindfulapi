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
    description:
      'Number of pages that failed during processing. Includes pages whose navigation ended with an HTTP error status (400 or higher), pages that reached an address blocked by the target policy (for example through a redirect), and pages whose processing did not finish within the two-minute per-page time limit; such pages contribute no issues.',
  })
  pagesFailed: number;
}
