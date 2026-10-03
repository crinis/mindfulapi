import { CrawlStrategy } from '../enums/crawl-strategy.enum';
import { isWithinCrawlScope, resolveSeedScope } from './crawl-scope.util';

describe('resolveSeedScope', () => {
  it.each([
    ['apex → www', 'https://example.com/', 'https://www.example.com/'],
    ['www → apex', 'https://www.example.com/', 'https://example.com/'],
    ['http → https', 'http://example.com/', 'https://example.com/start'],
    [
      'subdomain of the same site',
      'https://example.com/',
      'https://shop.example.com/',
    ],
    [
      'public-suffix aware',
      'https://example.co.uk/',
      'https://www.example.co.uk/',
    ],
    [
      'same IP host, other port',
      'http://127.0.0.1:8080/',
      'http://127.0.0.1:9090/',
    ],
  ])(
    'moves the scope to a same-site landing URL (%s)',
    (_label, seed, final) => {
      expect(resolveSeedScope(seed, final)).toBe(final);
    },
  );

  it.each([
    ['another site', 'https://example.com/', 'https://elsewhere.org/'],
    [
      'a sibling under a public suffix',
      'https://example.co.uk/',
      'https://other.co.uk/',
    ],
    [
      'another loopback name',
      'http://127.0.0.1:8080/',
      'http://localhost:8080/',
    ],
  ])('keeps the seed as scope when it lands on %s', (_label, seed, final) => {
    expect(resolveSeedScope(seed, final)).toBe(seed);
  });
});

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
