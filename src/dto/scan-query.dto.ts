import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUrl } from 'class-validator';

/**
 * Query parameters for the GET /scans list endpoint.
 * All fields are optional — omitting them returns all scans.
 */
export class ScanQueryDto {
  /** Filter results to scans for a specific URL. */
  @ApiPropertyOptional({
    example: 'https://example.com',
    description:
      'Filter scans by exact URL match. When omitted, all scans are returned.',
  })
  @IsOptional()
  @IsUrl({
    require_tld: false,
    require_protocol: true,
    protocols: ['http', 'https'],
  })
  url?: string;
}
