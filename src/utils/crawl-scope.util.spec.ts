import { CrawlStrategy } from '../enums/crawl-strategy.enum';
import { isWithinCrawlScope } from './crawl-scope.util';

describe('isWithinCrawlScope', () => {
  const scope = 'https://www.example.com/';

  it('accepts any HTTP(S) URL for the all strategy', () => {
    expect(
      isWithinCrawlScope('http://elsewhere.org/x', scope, CrawlStrategy.All),
    ).toBe(true);
  });

  it.each([
    ['same host', 'https://www.example.com/about', true],
    ['same host over http', 'http://www.example.com/about', true],
    ['another subdomain', 'https://shop.example.com/', false],
    ['the apex', 'https://example.com/', false],
    ['another port', 'https://www.example.com:8443/', false],
    ['another site', 'https://elsewhere.org/', false],
  ])('same_hostname: %s → %s', (_label, url, expected) => {
    expect(isWithinCrawlScope(url, scope, CrawlStrategy.SameHostname)).toBe(
      expected,
    );
  });

  it.each([
    ['same origin', 'https://www.example.com/about', true],
    ['same host over http', 'http://www.example.com/about', false],
    ['another subdomain', 'https://shop.example.com/', false],
  ])('same_origin: %s → %s', (_label, url, expected) => {
    expect(isWithinCrawlScope(url, scope, CrawlStrategy.SameOrigin)).toBe(
      expected,
    );
  });

  it.each([
    ['another subdomain', 'https://shop.example.com/', true],
    ['the apex over http', 'http://example.com/', true],
    ['another site', 'https://example.org/', false],
    ['a lookalike suffix', 'https://example.com.evil.net/', false],
  ])('same_domain: %s → %s', (_label, url, expected) => {
    expect(isWithinCrawlScope(url, scope, CrawlStrategy.SameDomain)).toBe(
      expected,
    );
  });

  it('compares IP hosts exactly for same_domain', () => {
    const ipScope = 'http://127.0.0.1:8080/';
    expect(
      isWithinCrawlScope(
        'http://127.0.0.1:8080/a',
        ipScope,
        CrawlStrategy.SameDomain,
      ),
    ).toBe(true);
    expect(
      isWithinCrawlScope(
        'http://localhost:8080/a',
        ipScope,
        CrawlStrategy.SameDomain,
      ),
    ).toBe(false);
  });

  it('rejects unparsable URLs', () => {
    expect(
      isWithinCrawlScope('not a url', scope, CrawlStrategy.SameHostname),
    ).toBe(false);
  });
});
