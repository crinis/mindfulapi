/**
 * Canonical crawl options used after merging defaults and user-provided overrides.
 */
interface CrawlOptionsConfig {
  /** Upper limit of pages analyzed in a crawl run. */
  maxPages: number;
  /** Maximum link depth from each crawl seed. */
  maxDepth: number;
  /** Whether discovery is constrained to the seed host(s). */
  sameHostOnly: boolean;
  /** Regex patterns that discovered URLs must match to be included. */
  includePatterns: string[];
  /** Regex patterns that exclude discovered URLs. */
  excludePatterns: string[];
  /** Number of pages analyzed concurrently. */
  concurrency: number;
}

/** Validation bounds shared by DTO validation and API docs. */
export const CRAWL_LIMITS = {
  maxPages: { min: 1, max: 5000 },
  maxDepth: { min: 0, max: 20 },
  concurrency: { min: 1, max: 16 },
} as const;

/** Default crawl behavior applied when crawlOptions are omitted. */
export const DEFAULT_CRAWL_OPTIONS: Readonly<CrawlOptionsConfig> = {
  maxPages: 250,
  maxDepth: 4,
  sameHostOnly: true,
  includePatterns: [],
  excludePatterns: [],
  concurrency: 4,
};
