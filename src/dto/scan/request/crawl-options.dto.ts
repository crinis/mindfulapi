import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import {
  CRAWL_LIMITS,
  DEFAULT_CRAWL_OPTIONS,
} from '../../../constants/crawl-options.constants';

/**
 * Crawl-only options.
 */
export class CrawlOptionsDto {
  /** Maximum number of pages to discover and analyze in the crawl run. */
  @ApiPropertyOptional({
    example: DEFAULT_CRAWL_OPTIONS.maxPages,
    description: 'Maximum number of pages to crawl and analyze.',
    default: DEFAULT_CRAWL_OPTIONS.maxPages,
    minimum: CRAWL_LIMITS.maxPages.min,
    maximum: CRAWL_LIMITS.maxPages.max,
  })
  @IsOptional()
  @IsInt()
  @Min(CRAWL_LIMITS.maxPages.min)
  @Max(CRAWL_LIMITS.maxPages.max)
  maxPages?: number;

  /** Maximum number of link hops from each crawl seed URL. */
  @ApiPropertyOptional({
    example: DEFAULT_CRAWL_OPTIONS.maxDepth,
    description: 'Maximum crawl depth from each start URL.',
    default: DEFAULT_CRAWL_OPTIONS.maxDepth,
    minimum: CRAWL_LIMITS.maxDepth.min,
    maximum: CRAWL_LIMITS.maxDepth.max,
  })
  @IsOptional()
  @IsInt()
  @Min(CRAWL_LIMITS.maxDepth.min)
  @Max(CRAWL_LIMITS.maxDepth.max)
  maxDepth?: number;

  /** Restricts discovered URLs to the same host(s) as the provided seed URLs. */
  @ApiPropertyOptional({
    example: DEFAULT_CRAWL_OPTIONS.sameHostOnly,
    description:
      'When true, only URLs on the host(s) of start URLs are crawled.',
    default: DEFAULT_CRAWL_OPTIONS.sameHostOnly,
  })
  @IsOptional()
  @IsBoolean()
  sameHostOnly?: boolean;

  /** Regex patterns discovered URLs must match to be considered crawl targets. */
  @ApiPropertyOptional({
    example: ['^https://example.com/docs'],
    description:
      'Optional regex patterns. URL must match at least one pattern to be crawled.',
    uniqueItems: true,
    minItems: 1,
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  includePatterns?: string[];

  /** Regex patterns used to skip discovered URLs during crawl discovery. */
  @ApiPropertyOptional({
    example: ['\\?.*preview=true'],
    description:
      'Optional regex patterns. URLs matching any pattern are skipped during crawl.',
    uniqueItems: true,
    minItems: 1,
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  excludePatterns?: string[];

  /** Maximum number of pages analyzed in parallel during crawl processing. */
  @ApiPropertyOptional({
    example: DEFAULT_CRAWL_OPTIONS.concurrency,
    description: 'Number of pages to analyze concurrently in crawl mode.',
    default: DEFAULT_CRAWL_OPTIONS.concurrency,
    minimum: CRAWL_LIMITS.concurrency.min,
    maximum: CRAWL_LIMITS.concurrency.max,
  })
  @IsOptional()
  @IsInt()
  @Min(CRAWL_LIMITS.concurrency.min)
  @Max(CRAWL_LIMITS.concurrency.max)
  concurrency?: number;
}
