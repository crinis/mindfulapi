import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsOptional, IsUrl } from 'class-validator';

/**
 * Query parameters for the GET /scans/:id endpoint.
 */
export class ScanByIdQueryDto {
  /**
   * When provided, only violations containing at least one issue on one of the given
   * page URLs are included in the response. Violations with no matching issues are omitted.
   * Accepts one or more values: `?pageUrl=https://a.com&pageUrl=https://b.com`
   */
  @ApiPropertyOptional({
    type: [String],
    format: 'uri',
    description:
      'Filter returned violations to those with at least one issue on any of the given page URLs. Repeat the parameter for multiple values. Violations with no matching issues are omitted.',
    example: 'https://example.com/about',
  })
  @IsOptional()
  @IsArray()
  @IsUrl(
    { require_tld: false, require_protocol: true, protocols: ['http', 'https'] },
    { each: true },
  )
  @Transform(({ value }) => (Array.isArray(value) ? value : [value]))
  pageUrl?: string[];
}
