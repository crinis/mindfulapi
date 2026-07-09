import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** Default number of items returned per page. */
export const DEFAULT_PAGE_LIMIT = 20;
/** Maximum number of items a client may request per page. */
export const MAX_PAGE_LIMIT = 100;

/**
 * Offset-based pagination query parameters shared by list endpoints.
 */
export class PageQueryDto {
  /** Maximum number of items to return. */
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: MAX_PAGE_LIMIT,
    default: DEFAULT_PAGE_LIMIT,
    description: `Maximum number of items to return (1-${MAX_PAGE_LIMIT}).`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_LIMIT)
  limit: number = DEFAULT_PAGE_LIMIT;

  /** Number of items to skip from the start of the collection. */
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    default: 0,
    description: 'Number of items to skip.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}
