import { ApiProperty } from '@nestjs/swagger';
import {
  CRAWL_LIMITS,
  DEFAULT_CRAWL_OPTIONS,
} from '../../../constants/crawl-options.constants';

/**
 * Effective crawl configuration used for a crawl-mode scan run.
 */
export class CrawlOptionsResponseDto {
  /** Maximum number of pages the crawler attempts to analyze. */
  @ApiProperty({
    example: DEFAULT_CRAWL_OPTIONS.maxPages,
    minimum: CRAWL_LIMITS.maxPages.min,
    maximum: CRAWL_LIMITS.maxPages.max,
    description: 'Maximum number of pages the crawler will analyze.',
  })
  maxPages: number;

  /** Maximum crawl discovery depth from each seed URL. */
  @ApiProperty({
    example: DEFAULT_CRAWL_OPTIONS.maxDepth,
    minimum: CRAWL_LIMITS.maxDepth.min,
    maximum: CRAWL_LIMITS.maxDepth.max,
    description: 'Maximum crawl depth from each seed URL.',
  })
  maxDepth: number;

  /** Whether URL discovery is restricted to seed hostnames. */
  @ApiProperty({
    example: DEFAULT_CRAWL_OPTIONS.sameHostOnly,
    description: 'Whether discovery is restricted to seed hostnames.',
  })
  sameHostOnly: boolean;

  /** Regex patterns that discovered URLs must match to be included. */
  @ApiProperty({
    example: ['^https://example.com/docs'],
    isArray: true,
    uniqueItems: true,
    description:
      'Regex patterns used to include discovered URLs during crawling.',
  })
  includePatterns: string[];

  /** Regex patterns used to exclude discovered URLs. */
  @ApiProperty({
    example: ['\\?.*preview=true'],
    isArray: true,
    uniqueItems: true,
    description:
      'Regex patterns used to exclude discovered URLs during crawling.',
  })
  excludePatterns: string[];

  /** Maximum concurrent page analyses in crawl mode. */
  @ApiProperty({
    example: DEFAULT_CRAWL_OPTIONS.concurrency,
    minimum: CRAWL_LIMITS.concurrency.min,
    maximum: CRAWL_LIMITS.concurrency.max,
    description: 'Maximum number of pages analyzed concurrently in crawl mode.',
  })
  concurrency: number;
}
