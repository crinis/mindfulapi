import { ApiProperty } from '@nestjs/swagger';
import {
  CRAWL_LIMITS,
  DEFAULT_CRAWL_OPTIONS,
} from '../../../constants/crawl-options.constants';
import { CrawlStrategy } from '../../../enums/crawl-strategy.enum';

/**
 * Effective crawl configuration used for a crawl-mode scan run.
 */
export class CrawlOptionsResponseDto {
  /** Maximum number of pages the crawler attempts to analyze. */
  @ApiProperty({
    type: 'integer',
    example: DEFAULT_CRAWL_OPTIONS.maxPages,
    minimum: CRAWL_LIMITS.maxPages.min,
    maximum: CRAWL_LIMITS.maxPages.max,
    description: 'Maximum number of pages the crawler will analyze.',
  })
  maxPages: number;

  /** Maximum crawl discovery depth from each seed URL. */
  @ApiProperty({
    type: 'integer',
    example: DEFAULT_CRAWL_OPTIONS.maxDepth,
    minimum: CRAWL_LIMITS.maxDepth.min,
    maximum: CRAWL_LIMITS.maxDepth.max,
    description: 'Maximum crawl depth from each seed URL.',
  })
  maxDepth: number;

  /** Crawlee link-following strategy for this run. */
  @ApiProperty({
    enum: CrawlStrategy,
    example: DEFAULT_CRAWL_OPTIONS.strategy,
    description: 'URL discovery strategy used during crawling.',
  })
  strategy: CrawlStrategy;

  /** Glob patterns that discovered URLs must match to be enqueued. */
  @ApiProperty({
    example: ['https://example.com/docs/**'],
    type: [String],
    uniqueItems: true,
    description:
      'Glob patterns used to include discovered URLs during crawling.',
  })
  globs: string[];

  /** Glob patterns used to exclude discovered URLs. */
  @ApiProperty({
    example: ['**/private/**'],
    type: [String],
    uniqueItems: true,
    description:
      'Glob patterns used to exclude discovered URLs during crawling.',
  })
  excludeGlobs: string[];
}
