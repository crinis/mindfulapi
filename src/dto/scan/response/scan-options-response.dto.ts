import { ApiProperty } from '@nestjs/swagger';

/**
 * Effective axe scan options used for a scan run.
 */
export class ScanOptionsResponseDto {
  /** CSS selector used to limit scan scope, or `null` for full-page scanning. */
  @ApiProperty({
    type: String,
    example: 'main',
    nullable: true,
    description:
      'CSS selector used to scope scans. Null means entire page scanning.',
  })
  rootElement: string | null;

  /** Effective subset of axe rule IDs, or `null` when all rules were run. */
  @ApiProperty({
    example: ['color-contrast', 'image-alt'],
    type: [String],
    nullable: true,
    description: 'Subset of axe rule IDs executed for this run.',
    uniqueItems: true,
  })
  ruleIds: string[] | null;
}
