import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
} from 'class-validator';

/**
 * Scan behavior options that apply to every mode.
 */
export class ScanOptionsDto {
  /** CSS selector to limit scan scope. When omitted, entire page is scanned. */
  @ApiPropertyOptional({
    example: 'main',
    description:
      'CSS selector to restrict the scan to a specific page region. Scans the entire page when omitted.',
    minLength: 1,
  })
  @IsOptional()
  @IsString()
  rootElement?: string;

  /** Specific axe rule IDs to run. When omitted, all rules run. */
  @ApiPropertyOptional({
    example: ['color-contrast', 'image-alt'],
    description:
      'Specific axe rule IDs to run. All rules run when omitted. See GET /rules for available IDs.',
    uniqueItems: true,
    minItems: 1,
    maxItems: 200,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsString({ each: true })
  ruleIds?: string[];
}
