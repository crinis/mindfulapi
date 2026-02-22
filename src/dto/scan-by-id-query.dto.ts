import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, type TransformFnParams } from 'class-transformer';
import { IsArray, IsOptional, IsUrl } from 'class-validator';
import { HTTP_URL_VALIDATION_OPTIONS } from '../constants/url-validation.constants';

function normalizeRepeatedQueryParam(value: unknown): string[] | undefined {
  const values = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : typeof value === 'string'
      ? [value]
      : [];
  const deduped = Array.from(
    new Set(
      values.map((entry) => entry.trim()).filter((entry) => entry.length),
    ),
  );
  return deduped.length ? deduped : undefined;
}

/**
 * Query parameters for the GET /scans/:id endpoint.
 */
export class ScanByIdQueryDto {
  /**
   * When provided, only violations containing at least one issue on one of the given
   * page URLs are included in the response. Violations with no matching issues are omitted.
   * Accepts one or more values: `?pageUrls=https://a.com&pageUrls=https://b.com`
   */
  @ApiPropertyOptional({
    type: [String],
    format: 'uri',
    description:
      'Filter returned violations to those with at least one issue on any of the given page URLs. Repeat the parameter for multiple values. Violations with no matching issues are omitted.',
    example: ['https://example.com/about'],
  })
  @IsOptional()
  @IsArray()
  @IsUrl(HTTP_URL_VALIDATION_OPTIONS, { each: true })
  @Transform(({ value }: TransformFnParams) =>
    normalizeRepeatedQueryParam(value),
  )
  pageUrls?: string[];
}
