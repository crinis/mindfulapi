import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsUrl, IsOptional, IsArray } from 'class-validator';

/**
 * Data Transfer Object for creating new accessibility scans.
 */
export class CreateScanDto {
  /** Target URL to scan. Supports HTTP and HTTPS. TLD not required. */
  @ApiProperty({
    example: 'https://example.com',
    description: 'Target URL to scan. HTTP and HTTPS supported.',
  })
  @IsUrl({
    require_tld: false,
    require_protocol: true,
    protocols: ['http', 'https'],
  })
  url: string;

  /** CSS selector to limit scan scope. When omitted, the entire page is scanned. */
  @ApiPropertyOptional({
    example: 'main',
    description:
      'CSS selector to restrict the scan to a specific page region. Scans the entire page when omitted.',
  })
  @IsOptional()
  @IsString()
  rootElement?: string;

  /** Specific axe rule IDs to run. When omitted, all rules run. */
  @ApiPropertyOptional({
    example: ['color-contrast', 'image-alt'],
    description:
      'Specific axe rule IDs to run. All rules run when omitted. See GET /rules for available IDs.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  ruleIds?: string[];
}
