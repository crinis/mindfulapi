/**
 * URL-matching strategy passed to Crawlee's `enqueueLinks` during crawl discovery.
 *
 * Wire values are snake_case for consistency with the rest of the API (e.g.
 * {@link ScanMode}). They are mapped to Crawlee's kebab-case
 * {@link https://crawlee.dev/api/core/enum/EnqueueStrategy | EnqueueStrategy}
 * in the scan processor.
 */
export enum CrawlStrategy {
  /** Follow all discovered links regardless of host or protocol. */
  All = 'all',
  /**
   * Only follow links on the same hostname as the page being crawled.
   * For example, `https://docs.example.com` and `https://example.com` are
   * treated as different hosts.
   */
  SameHostname = 'same_hostname',
  /**
   * Only follow links that share the same registered domain.
   * For example, `https://docs.example.com` and `https://example.com` both
   * match for a seed of `https://example.com`.
   */
  SameDomain = 'same_domain',
  /**
   * Only follow links that share both the same hostname and protocol.
   * `http://example.com` will not match a seed of `https://example.com`.
   */
  SameOrigin = 'same_origin',
}
