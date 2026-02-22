import { CrawlStrategy } from '../enums/crawl-strategy.enum';

/**
 * Canonical crawl options used after merging defaults and user-provided overrides.
 */
interface CrawlOptionsConfig {
  /** Upper limit of pages analyzed in a crawl run. */
  maxPages: number;
  /** Maximum link depth from each crawl seed. */
  maxDepth: number;
  /** Crawlee enqueue strategy controlling which discovered URLs are followed. */
  strategy: CrawlStrategy;
  /** Glob patterns that discovered URLs must match to be enqueued. */
  globs: string[];
  /** Glob patterns that exclude discovered URLs from being enqueued. */
  excludeGlobs: string[];
}

/** Validation bounds shared by DTO validation and API docs. */
export const CRAWL_LIMITS = {
  maxPages: { min: 1, max: 5000 },
  maxDepth: { min: 0, max: 20 },
} as const;

/** Default crawl behavior applied when crawlOptions are omitted. */
export const DEFAULT_CRAWL_OPTIONS: Readonly<CrawlOptionsConfig> = {
  maxPages: 250,
  maxDepth: 4,
  strategy: CrawlStrategy.SameHostname,
  globs: [],
  excludeGlobs: [],
};
