import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUrl } from 'class-validator';
import { HTTP_URL_VALIDATION_OPTIONS } from '../constants/url-validation.constants';

/**
 * Query parameters for the GET /scans list endpoint.
 * All fields are optional — omitting them returns all scans.
 */
export class ScanQueryDto {
  /** Filter results to scan runs containing a specific target URL. */
  @ApiPropertyOptional({
    example: 'https://example.com',
    format: 'uri',
    description:
      'Filter runs by exact match in normalized input targets. When omitted, all scan runs are returned.',
  })
  @IsOptional()
  @IsUrl(HTTP_URL_VALIDATION_OPTIONS)
  target?: string;
}
