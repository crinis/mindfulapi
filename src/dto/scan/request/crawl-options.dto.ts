import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
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
import { CrawlStrategy } from '../../../enums/crawl-strategy.enum';

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

  /**
   * Crawlee link-following strategy that controls which discovered URLs are enqueued.
   * Defaults to `same-hostname` which restricts crawling to the seed host(s).
   */
  @ApiPropertyOptional({
    enum: CrawlStrategy,
    example: DEFAULT_CRAWL_OPTIONS.strategy,
    default: DEFAULT_CRAWL_OPTIONS.strategy,
    description:
      'URL discovery strategy. `same-hostname` restricts to the seed host, ' +
      '`same-domain` allows subdomains, `same-origin` also matches protocol, ' +
      '`all` follows any link.',
  })
  @IsOptional()
  @IsEnum(CrawlStrategy)
  strategy?: CrawlStrategy;

  /**
   * Glob patterns discovered URLs must match to be enqueued.
   * Useful for restricting the crawl to a specific path prefix, e.g.
   * `https://example.com/docs/**`.
   */
  @ApiPropertyOptional({
    example: ['https://example.com/docs/**'],
    description:
      'Glob patterns. A discovered URL must match at least one pattern to be crawled.',
    uniqueItems: true,
    minItems: 1,
    maxItems: 20,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  globs?: string[];

  /** Glob patterns used to skip discovered URLs during crawl discovery. */
  @ApiPropertyOptional({
    example: ['**/private/**'],
    description:
      'Glob patterns. URLs matching any pattern are skipped during crawl.',
    uniqueItems: true,
    minItems: 1,
    maxItems: 20,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  excludeGlobs?: string[];
}
