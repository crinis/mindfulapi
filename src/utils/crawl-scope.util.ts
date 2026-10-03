import { getDomain } from 'tldts';
import { CrawlStrategy } from '../enums/crawl-strategy.enum';

/**
 * Registrable domain ("site") of a hostname, e.g. `example.co.uk` for
 * `www.example.co.uk`. Hosts without one (IP addresses, `localhost`) are their
 * own site. Uses the same public-suffix lookup as Crawlee's `same-domain`
 * enqueue strategy.
 */
function siteOf(hostname: string): string {
  return getDomain(hostname, { mixedInputs: false }) ?? hostname;
}

/**
 * Picks the crawl scope of a seed after navigating to it: its landing URL when
 * the seed redirected within its own site (apex → www, http → https, another
 * subdomain), otherwise the seed URL itself — a redirect to another site must
 * not move the whole crawl there.
 *
 * @param seedUrl URL the seed was requested with.
 * @param finalUrl URL the seed's navigation ended on.
 */
export function resolveSeedScope(seedUrl: string, finalUrl: string): string {
  try {
    const seed = new URL(seedUrl);
    const final = new URL(finalUrl);
    return siteOf(seed.hostname) === siteOf(final.hostname)
      ? finalUrl
      : seedUrl;
  } catch {
    return seedUrl;
  }
}

/**
 * Whether a URL belongs to a crawl scope under an enqueue strategy, mirroring
 * how Crawlee's `enqueueLinks` filters links against its `baseUrl`:
 * `same_hostname` compares host and port (any HTTP scheme), `same_origin` also
 * the scheme, `same_domain` the registrable domain and port, and `all` accepts
 * everything.
 *
 * @param url URL to test, e.g. the final URL of a crawled page.
 * @param scopeUrl Scope of the crawl (see {@link resolveSeedScope}).
 * @param strategy Crawl strategy of the scan.
 */
export function isWithinCrawlScope(
  url: string,
  scopeUrl: string,
  strategy: CrawlStrategy,
): boolean {
  let candidate: URL;
  let scope: URL;
  try {
    candidate = new URL(url);
    scope = new URL(scopeUrl);
  } catch {
    return false;
  }

  switch (strategy) {
    case CrawlStrategy.All:
      return true;
    case CrawlStrategy.SameOrigin:
      return candidate.origin === scope.origin;
    case CrawlStrategy.SameDomain:
      return (
        candidate.port === scope.port &&
        siteOf(candidate.hostname) === siteOf(scope.hostname)
      );
    case CrawlStrategy.SameHostname:
    default:
      return candidate.host === scope.host;
  }
}
