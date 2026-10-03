let mockRequestQueueOpen: jest.Mock;
let mockQueueAddRequests: jest.Mock;
let mockQueueDrop: jest.Mock;
let mockCrawlerRunHandler:
  | ((options: {
      requestHandler: (context: any) => Promise<void>;
      failedRequestHandler?: (context: any) => Promise<void>;
    }) => Promise<void>)
  | null;

jest.mock('crawlee', () => ({
  EnqueueStrategy: {
    All: 'all',
    SameHostname: 'same-hostname',
  },
  Configuration: class MockConfiguration {
    constructor(readonly opts?: any) {}
  },
  RequestQueue: {
    open: (...args: unknown[]) => mockRequestQueueOpen(...args),
  },
  BasicCrawler: class MockBasicCrawler {
    constructor(private readonly options: any) {}
    async run() {
      if (mockCrawlerRunHandler) {
        await mockCrawlerRunHandler(this.options);
      }
    }
  },
}));

jest.mock('@crawlee/memory-storage', () => ({
  MemoryStorage: class MockMemoryStorage {
    constructor(readonly opts?: any) {}
  },
}));

import { ScanProcessor } from './scan.processor';
import { BasicAuthCryptoService } from './basic-auth-crypto.service';
import {
  PageNavigationError,
  TargetPolicyViolationError,
} from './axe-accessibility-scanner.service';
import { scanConfig } from '../config/configuration';
import { Scan } from '../entities/scan.entity';
import { ScanMode } from '../enums/scan-mode.enum';
import { ScanStatus } from '../enums/scan-status.enum';
import { IssueImpact } from '../enums/issue-impact.enum';
import { CrawlStrategy } from '../enums/crawl-strategy.enum';

type MockRepo = {
  findOne: jest.Mock;
  update: jest.Mock;
  createQueryBuilder?: jest.Mock;
  create?: jest.Mock;
  save?: jest.Mock;
};

const makeScan = (overrides: Partial<Scan> = {}): Scan => ({
  id: 1,
  mode: ScanMode.SINGLE_URL,
  targets: ['https://example.com'],
  rootElement: undefined,
  ruleIds: null,
  basicAuthUsernameEncrypted: null,
  basicAuthPasswordEncrypted: null,
  crawlMaxPages: null,
  crawlMaxDepth: null,
  crawlStrategy: null,
  crawlGlobs: null,
  crawlExcludeGlobs: null,
  status: ScanStatus.PENDING,
  pagesDiscovered: 0,
  pagesScanned: 0,
  pagesFailed: 0,
  issues: [],
  aiAuditSkills: null,
  aiTasksTotal: 0,
  aiTasksCompleted: 0,
  aiTasksFailed: 0,
  agentFindings: [],
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

/** A request the simulated crawler handed to the processor. */
interface SimulatedRequest {
  url: string;
  uniqueKey: string;
  userData: Record<string, unknown>;
}

/**
 * Drives the processor's requestHandler like Crawlee's BasicCrawler: a FIFO
 * queue seeded with `seeds` and an enqueueLinks that, like Crawlee, applies
 * `userData`, filters by strategy against `baseUrl` (simplified: hostname for
 * same-hostname) and by globs, then calls transformRequestFunction.
 */
function simulateCrawl(seeds: string[]) {
  const handled: SimulatedRequest[] = [];
  const enqueueCalls: Array<{ baseUrl?: string; urls: string[] }> = [];

  const run = async ({
    requestHandler,
  }: {
    requestHandler: (context: any) => Promise<void>;
  }) => {
    const pending: SimulatedRequest[] = seeds.map((url) => ({
      url,
      uniqueKey: url,
      userData: { depth: 0 },
    }));

    while (pending.length > 0) {
      const request = pending.shift()!;
      handled.push(request);
      const enqueueLinks = (options: any) => {
        enqueueCalls.push({ baseUrl: options.baseUrl, urls: options.urls });
        for (const href of options.urls || []) {
          if (
            options.strategy === 'same-hostname' &&
            new URL(href).hostname !==
              new URL(options.baseUrl ?? request.url).hostname
          ) {
            continue;
          }
          if (
            options.globs &&
            !options.globs.some((g: string) =>
              href.startsWith(g.replace('/**', '')),
            )
          ) {
            continue;
          }
          if (
            options.exclude &&
            options.exclude.some((g: string) =>
              href.includes(g.replace('**/', '').replace('/**', '')),
            )
          ) {
            continue;
          }
          const transformed = options.transformRequestFunction({
            url: href,
            userData: { ...(options.userData ?? {}) },
          });
          if (transformed) {
            pending.push(transformed);
          }
        }
      };
      await requestHandler({ request, enqueueLinks });
    }
  };

  return { run, handled, enqueueCalls };
}

describe('ScanProcessor', () => {
  let processor: ScanProcessor;
  let mockScanRepo: MockRepo;
  let mockIssueRepo: MockRepo;
  let mockScanQb: {
    addSelect: jest.Mock;
    where: jest.Mock;
    getOne: jest.Mock;
  };
  let mockBrowserService: { getBrowser: jest.Mock };
  let mockScanner: {
    createContext: jest.Mock;
    scanPage: jest.Mock;
    openPage: jest.Mock;
    analyzeLoadedPage: jest.Mock;
    assertPageAllowed: jest.Mock;
  };
  let mockBasicAuthCrypto: jest.Mocked<
    Pick<BasicAuthCryptoService, 'decryptCredentials'>
  >;
  let mockUrlPolicy: { isAllowedTarget: jest.Mock };
  let mockAgentAudit: {
    resolveSkills: jest.Mock;
    reset: jest.Mock;
    collectForPage: jest.Mock;
    evaluate: jest.Mock;
  };
  let mockContext: { close: jest.Mock; newPage: jest.Mock };

  beforeEach(() => {
    mockQueueAddRequests = jest.fn().mockResolvedValue(undefined);
    mockQueueDrop = jest.fn().mockResolvedValue(undefined);
    mockRequestQueueOpen = jest.fn().mockResolvedValue({
      addRequests: mockQueueAddRequests,
      drop: mockQueueDrop,
    });
    mockCrawlerRunHandler = null;

    const qb = {
      delete: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    };

    mockScanRepo = {
      findOne: jest.fn(),
      // Mirrors TypeORM's UpdateResult; resetScanResults reads `affected` to
      // detect a cancellation that raced the RUNNING transition.
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    mockScanQb = {
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
    };
    mockScanRepo.createQueryBuilder = jest.fn().mockReturnValue(mockScanQb);

    mockIssueRepo = {
      findOne: jest.fn(),
      update: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      create: jest.fn((value: any) => value),
      save: jest.fn().mockResolvedValue(undefined),
    };

    mockBrowserService = { getBrowser: jest.fn().mockResolvedValue({}) };

    mockContext = {
      close: jest.fn().mockResolvedValue(undefined),
      newPage: jest.fn().mockImplementation(() =>
        Promise.resolve({
          url: jest.fn().mockReturnValue('https://example.com/'),
          evaluate: jest.fn().mockResolvedValue([]),
          close: jest.fn().mockResolvedValue(undefined),
        }),
      ),
    };

    mockScanner = {
      createContext: jest.fn().mockResolvedValue(mockContext),
      // Mirrors the real scanner: scanPage = openPage + analyzeLoadedPage.
      scanPage: jest.fn(
        async (page: unknown, url: string, options: unknown) => {
          const { finalUrl } = await mockScanner.openPage(page, url);
          return mockScanner.analyzeLoadedPage(page, options, finalUrl);
        },
      ),
      openPage: jest.fn((_page: unknown, url: string) =>
        Promise.resolve({ finalUrl: url, status: 200 }),
      ),
      analyzeLoadedPage: jest.fn(
        (_page: unknown, _options: unknown, pageUrl: string) =>
          Promise.resolve({ finalUrl: pageUrl, issues: [] }),
      ),
      assertPageAllowed: jest.fn().mockResolvedValue(undefined),
    };
    mockBasicAuthCrypto = {
      decryptCredentials: jest.fn(),
    };
    mockUrlPolicy = {
      isAllowedTarget: jest.fn().mockResolvedValue({ allowed: true }),
    };
    mockAgentAudit = {
      resolveSkills: jest.fn().mockReturnValue([]),
      reset: jest.fn().mockResolvedValue(undefined),
      collectForPage: jest.fn().mockResolvedValue([]),
      evaluate: jest.fn().mockResolvedValue(undefined),
    };

    processor = new ScanProcessor(
      mockScanRepo as any,
      mockIssueRepo as any,
      mockBrowserService as any,
      mockScanner as any,
      mockBasicAuthCrypto as any,
      scanConfig(),
      mockUrlPolicy as any,
      mockAgentAudit as any,
    );
  });

  it('throws when scan does not exist', async () => {
    mockScanQb.getOne.mockResolvedValue(null);

    await expect(
      processor.process({ data: { scanId: 999 } } as any),
    ).rejects.toThrow('Scan 999 not found');
    expect(mockScanRepo.update).not.toHaveBeenCalled();
  });

  it('aborts without scanning when a cancellation races the reset', async () => {
    mockScanQb.getOne.mockResolvedValue(
      makeScan({ targets: ['https://example.com'] }),
    );
    // The guarded RUNNING transition matches no row (status already CANCELED),
    // so resetScanResults reports the run must not proceed.
    mockScanRepo.update.mockResolvedValueOnce({ affected: 0 });

    await processor.process({ data: { scanId: 1 } } as any);

    expect(mockScanner.scanPage).not.toHaveBeenCalled();
    // Only the reset attempt ran; no COMPLETED transition followed.
    expect(mockScanRepo.update).toHaveBeenCalledTimes(1);
  });

  it('processes single_url runs and stores issues', async () => {
    mockScanQb.getOne.mockResolvedValue(
      makeScan({
        targets: ['https://example.com'],
        rootElement: 'main',
        ruleIds: ['image-alt'],
      }),
    );
    mockScanner.scanPage.mockResolvedValue({
      finalUrl: 'https://example.com/',
      issues: [
        {
          ruleId: 'image-alt',
          description: 'Images must have alternative text',
          impact: IssueImpact.CRITICAL,
          pageUrl: 'https://example.com/',
          selector: 'img',
          context: '<img src="x.png">',
          helpUrl:
            'https://dequeuniversity.com/rules/axe/4.11/image-alt?application=playwright',
        },
      ],
    });

    await processor.process({ data: { scanId: 1 } } as any);

    expect(mockScanner.createContext).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        rootElement: 'main',
        ruleIds: ['image-alt'],
      }),
    );
    expect(mockScanner.scanPage).toHaveBeenCalledTimes(1);
    expect(mockScanner.scanPage.mock.calls[0][1]).toBe('https://example.com/');
    expect(mockIssueRepo.save).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          pageUrl: 'https://example.com/',
          ruleId: 'image-alt',
        }),
      ]),
    );
    expect(mockScanRepo.update).toHaveBeenLastCalledWith(1, {
      status: ScanStatus.COMPLETED,
      pagesDiscovered: 1,
      pagesScanned: 1,
      pagesFailed: 0,
    });
    expect(mockContext.close).toHaveBeenCalled();
  });

  it('tracks page failures for url_list runs and still completes', async () => {
    mockScanQb.getOne.mockResolvedValue(
      makeScan({
        mode: ScanMode.URL_LIST,
        targets: ['https://example.com/a', 'https://example.com/b'],
      }),
    );
    mockScanner.scanPage.mockImplementation((_page: unknown, url: string) => {
      if (url.endsWith('/b')) {
        throw new Error('page failed');
      }
      return {
        finalUrl: url,
        issues: [],
      };
    });

    await processor.process({ data: { scanId: 1 } } as any);

    expect(mockScanner.scanPage).toHaveBeenCalledTimes(2);
    expect(mockScanRepo.update).toHaveBeenLastCalledWith(1, {
      status: ScanStatus.COMPLETED,
      pagesDiscovered: 2,
      pagesScanned: 1,
      pagesFailed: 1,
    });
  });

  it('uses Crawlee BasicCrawler with BrowserService for crawl mode', async () => {
    mockScanQb.getOne.mockResolvedValue(
      makeScan({
        mode: ScanMode.CRAWL,
        targets: ['https://example.com'],
        crawlMaxPages: 2,
        crawlMaxDepth: 1,
        crawlStrategy: CrawlStrategy.SameHostname,
        crawlGlobs: ['https://example.com/**'],
        crawlExcludeGlobs: ['**/admin/**'],
      }),
    );

    const pageHrefs = [
      'https://example.com/about',
      'https://example.com/admin',
      'https://other.example.com/x',
    ];
    mockContext.newPage.mockImplementation(() =>
      Promise.resolve({
        url: jest.fn().mockReturnValue('https://example.com/'),
        evaluate: jest.fn().mockResolvedValue(pageHrefs),
        close: jest.fn().mockResolvedValue(undefined),
      }),
    );

    mockScanner.analyzeLoadedPage.mockImplementation(
      (_page: unknown, _options: unknown, pageUrl: string) => ({
        finalUrl: pageUrl,
        issues: pageUrl.includes('/about')
          ? [
              {
                ruleId: 'color-contrast',
                description: 'Elements must have sufficient color contrast',
                impact: IssueImpact.SERIOUS,
                pageUrl,
              },
            ]
          : [],
      }),
    );

    mockCrawlerRunHandler = simulateCrawl(['https://example.com/']).run;

    await processor.process({ data: { scanId: 1 } } as any);

    expect(mockBrowserService.getBrowser).toHaveBeenCalled();
    expect(mockScanner.createContext).toHaveBeenCalled();
    expect(mockRequestQueueOpen).toHaveBeenCalled();
    expect(mockQueueAddRequests).toHaveBeenCalledWith([
      {
        url: 'https://example.com/',
        uniqueKey: 'https://example.com/',
        userData: { depth: 0 },
      },
    ]);
    expect(mockScanner.analyzeLoadedPage).toHaveBeenCalledTimes(2);
    expect(mockIssueRepo.save).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          pageUrl: 'https://example.com/about',
          ruleId: 'color-contrast',
        }),
      ]),
    );
    expect(mockContext.close).toHaveBeenCalled();
    expect(mockQueueDrop).toHaveBeenCalled();
    expect(mockScanRepo.update).toHaveBeenLastCalledWith(1, {
      status: ScanStatus.COMPLETED,
      pagesDiscovered: 2,
      pagesScanned: 2,
      pagesFailed: 0,
    });
  });

  describe('crawl scope across redirects', () => {
    /**
     * Pages whose URL follows openPage: `redirects` maps a requested URL to
     * its final URL, `links` maps a final URL to the hrefs found on it.
     */
    const serveSite = (
      redirects: Record<string, string>,
      links: Record<string, string[]>,
    ) => {
      mockContext.newPage.mockImplementation(() => {
        const page = {
          currentUrl: 'about:blank',
          url: jest.fn(() => page.currentUrl),
          evaluate: jest.fn(() =>
            Promise.resolve(links[page.currentUrl] ?? []),
          ),
          close: jest.fn().mockResolvedValue(undefined),
        };
        return Promise.resolve(page);
      });
      mockScanner.openPage.mockImplementation(
        (page: { currentUrl: string }, url: string) => {
          page.currentUrl = redirects[url] ?? url;
          return Promise.resolve({ finalUrl: page.currentUrl, status: 200 });
        },
      );
      mockScanner.analyzeLoadedPage.mockImplementation(
        (_page: unknown, _options: unknown, pageUrl: string) =>
          Promise.resolve({
            finalUrl: pageUrl,
            issues: [
              {
                ruleId: 'image-alt',
                description: 'Images must have alternative text',
                impact: IssueImpact.CRITICAL,
                pageUrl,
              },
            ],
          }),
      );
    };

    const crawlScan = (overrides: Partial<Scan> = {}) =>
      makeScan({
        mode: ScanMode.CRAWL,
        targets: ['https://example.com'],
        crawlMaxPages: 10,
        crawlMaxDepth: 3,
        crawlStrategy: CrawlStrategy.SameHostname,
        ...overrides,
      });

    const storedPageUrls = () =>
      (mockIssueRepo.save as jest.Mock).mock.calls.flatMap(([entities]) =>
        entities.map((entity: { pageUrl: string }) => entity.pageUrl),
      );

    it('skips a page that redirects off the crawl scope and does not crawl from it', async () => {
      mockScanQb.getOne.mockResolvedValue(crawlScan());
      serveSite(
        { 'https://example.com/out': 'https://other.example.net/landing' },
        {
          'https://example.com/': ['https://example.com/out'],
          'https://other.example.net/landing': [
            'https://other.example.net/next',
          ],
        },
      );
      const crawl = simulateCrawl(['https://example.com/']);
      mockCrawlerRunHandler = crawl.run;

      await processor.process({ data: { scanId: 1 } } as any);

      expect(crawl.handled.map((r) => r.url)).toEqual([
        'https://example.com/',
        'https://example.com/out',
      ]);
      expect(storedPageUrls()).toEqual(['https://example.com/']);
      expect(mockScanner.analyzeLoadedPage).toHaveBeenCalledTimes(1);
      expect(crawl.enqueueCalls).toEqual([
        { baseUrl: 'https://example.com/', urls: ['https://example.com/out'] },
      ]);
      // The redirect alias is not a page of this crawl.
      expect(mockScanRepo.update).toHaveBeenLastCalledWith(1, {
        status: ScanStatus.COMPLETED,
        pagesDiscovered: 1,
        pagesScanned: 1,
        pagesFailed: 0,
      });
    });

    it('scopes a seed by its same-site landing URL (apex → www)', async () => {
      mockScanQb.getOne.mockResolvedValue(crawlScan());
      serveSite(
        { 'https://example.com/': 'https://www.example.com/' },
        {
          'https://www.example.com/': [
            'https://www.example.com/about',
            'https://shop.example.com/',
          ],
        },
      );
      const crawl = simulateCrawl(['https://example.com/']);
      mockCrawlerRunHandler = crawl.run;

      await processor.process({ data: { scanId: 1 } } as any);

      expect(crawl.enqueueCalls[0].baseUrl).toBe('https://www.example.com/');
      expect(crawl.handled[1]).toEqual(
        expect.objectContaining({
          url: 'https://www.example.com/about',
          userData: expect.objectContaining({
            depth: 1,
            scopeUrl: 'https://www.example.com/',
          }),
        }),
      );
      expect(storedPageUrls()).toEqual([
        'https://www.example.com/',
        'https://www.example.com/about',
      ]);
    });

    it('fails a seed that redirects to another site', async () => {
      mockScanQb.getOne.mockResolvedValue(crawlScan());
      serveSite(
        { 'https://example.com/': 'https://elsewhere.org/' },
        { 'https://elsewhere.org/': ['https://elsewhere.org/more'] },
      );
      const crawl = simulateCrawl(['https://example.com/']);
      mockCrawlerRunHandler = crawl.run;

      await processor.process({ data: { scanId: 1 } } as any);

      expect(mockScanner.analyzeLoadedPage).not.toHaveBeenCalled();
      expect(mockIssueRepo.save).not.toHaveBeenCalled();
      expect(crawl.enqueueCalls).toEqual([]);
      expect(mockScanRepo.update).toHaveBeenLastCalledWith(1, {
        status: ScanStatus.COMPLETED,
        pagesDiscovered: 1,
        pagesScanned: 0,
        pagesFailed: 1,
      });
    });

    it('scans a page that several URLs redirect to only once', async () => {
      mockScanQb.getOne.mockResolvedValue(crawlScan());
      serveSite(
        {
          'https://example.com/a': 'https://example.com/target',
          'https://example.com/b': 'https://example.com/target/',
        },
        {
          'https://example.com/': [
            'https://example.com/a',
            'https://example.com/b',
          ],
        },
      );
      const crawl = simulateCrawl(['https://example.com/']);
      mockCrawlerRunHandler = crawl.run;

      await processor.process({ data: { scanId: 1 } } as any);

      expect(storedPageUrls()).toEqual([
        'https://example.com/',
        'https://example.com/target',
      ]);
      expect(mockScanRepo.update).toHaveBeenLastCalledWith(1, {
        status: ScanStatus.COMPLETED,
        pagesDiscovered: 2,
        pagesScanned: 2,
        pagesFailed: 0,
      });
    });

    it('follows a redirect to another host when the strategy is all', async () => {
      mockScanQb.getOne.mockResolvedValue(
        crawlScan({ crawlStrategy: CrawlStrategy.All }),
      );
      serveSite(
        { 'https://example.com/out': 'https://other.example.net/landing' },
        { 'https://example.com/': ['https://example.com/out'] },
      );
      mockCrawlerRunHandler = simulateCrawl(['https://example.com/']).run;

      await processor.process({ data: { scanId: 1 } } as any);

      expect(storedPageUrls()).toEqual([
        'https://example.com/',
        'https://other.example.net/landing',
      ]);
    });
  });

  it('tracks failed crawl pages via failedRequestHandler', async () => {
    mockScanQb.getOne.mockResolvedValue(
      makeScan({
        mode: ScanMode.CRAWL,
        targets: ['https://example.com'],
      }),
    );

    mockCrawlerRunHandler = async ({ failedRequestHandler }) => {
      if (failedRequestHandler) {
        await failedRequestHandler({
          request: { url: 'https://example.com/failed' },
        });
      }
    };

    await processor.process({ data: { scanId: 1 } } as any);

    expect(mockScanRepo.update).toHaveBeenLastCalledWith(1, {
      status: ScanStatus.COMPLETED,
      pagesDiscovered: 0,
      pagesScanned: 0,
      pagesFailed: 1,
    });
  });

  it('does not increment pagesFailed when only link extraction fails after a successful scan', async () => {
    mockScanQb.getOne.mockResolvedValue(
      makeScan({ mode: ScanMode.CRAWL, targets: ['https://example.com'] }),
    );

    mockContext.newPage.mockResolvedValue({
      url: jest.fn().mockReturnValue('https://example.com/'),
      evaluate: jest.fn().mockRejectedValue(new Error('page crashed')),
      close: jest.fn().mockResolvedValue(undefined),
    });

    mockCrawlerRunHandler = async ({ requestHandler }) => {
      await requestHandler({
        request: {
          url: 'https://example.com/',
          uniqueKey: 'https://example.com/',
          userData: { depth: 0 },
        },
        enqueueLinks: jest.fn(),
      });
    };

    await processor.process({ data: { scanId: 1 } } as any);

    expect(mockScanner.analyzeLoadedPage).toHaveBeenCalledTimes(1);
    expect(mockScanRepo.update).toHaveBeenLastCalledWith(1, {
      status: ScanStatus.COMPLETED,
      pagesDiscovered: 1,
      pagesScanned: 1,
      pagesFailed: 0,
    });
  });

  it('never stores, audits or mines links from a rejected crawl page', async () => {
    mockScanQb.getOne.mockResolvedValue(
      makeScan({ mode: ScanMode.CRAWL, targets: ['https://example.com'] }),
    );
    mockAgentAudit.resolveSkills.mockReturnValue([{ id: 'page_title' }]);
    const page = {
      url: jest.fn().mockReturnValue('https://example.com/'),
      evaluate: jest.fn().mockResolvedValue(['https://example.com/about']),
      close: jest.fn().mockResolvedValue(undefined),
    };
    mockContext.newPage.mockResolvedValue(page);
    mockScanner.openPage.mockRejectedValue(
      new PageNavigationError(
        'Navigation to https://example.com/ ended with HTTP 404',
      ),
    );
    const enqueueLinks = jest.fn();

    mockCrawlerRunHandler = async ({ requestHandler }) => {
      await requestHandler({
        request: {
          url: 'https://example.com/',
          uniqueKey: 'https://example.com/',
          userData: { depth: 0 },
        },
        enqueueLinks,
      });
    };

    await processor.process({ data: { scanId: 1 } } as any);

    expect(mockIssueRepo.save).not.toHaveBeenCalled();
    expect(mockAgentAudit.collectForPage).not.toHaveBeenCalled();
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(enqueueLinks).not.toHaveBeenCalled();
    expect(mockScanRepo.update).toHaveBeenLastCalledWith(1, {
      status: ScanStatus.COMPLETED,
      pagesDiscovered: 1,
      pagesScanned: 0,
      pagesFailed: 1,
    });
  });

  it('counts an HTTP error page in a url_list as failed and stores nothing', async () => {
    mockScanQb.getOne.mockResolvedValue(
      makeScan({
        mode: ScanMode.URL_LIST,
        targets: ['https://example.com/a', 'https://example.com/missing'],
      }),
    );
    mockAgentAudit.resolveSkills.mockReturnValue([{ id: 'page_title' }]);
    mockScanner.scanPage.mockImplementation((_page: unknown, url: string) =>
      url.endsWith('/missing')
        ? Promise.reject(
            new PageNavigationError(`Navigation to ${url} ended with HTTP 404`),
          )
        : Promise.resolve({ finalUrl: url, issues: [] }),
    );

    await processor.process({ data: { scanId: 1 } } as any);

    expect(mockAgentAudit.collectForPage).toHaveBeenCalledTimes(1);
    expect(mockAgentAudit.collectForPage.mock.calls[0][2]).toBe(
      'https://example.com/a',
    );
    expect(mockScanRepo.update).toHaveBeenLastCalledWith(1, {
      status: ScanStatus.COMPLETED,
      pagesDiscovered: 2,
      pagesScanned: 1,
      pagesFailed: 1,
    });
  });

  it('re-checks the target policy after evidence collection and discards a violating page', async () => {
    mockScanQb.getOne.mockResolvedValue(
      makeScan({ targets: ['https://example.com'] }),
    );
    mockAgentAudit.resolveSkills.mockReturnValue([{ id: 'image_alt_text' }]);
    mockAgentAudit.collectForPage.mockResolvedValue([{ id: 'unit-1' }]);
    (mockAgentAudit as any).remainingScanUnits = jest.fn().mockReturnValue(10);
    mockScanner.scanPage.mockResolvedValue({
      finalUrl: 'https://example.com/',
      issues: [
        {
          ruleId: 'image-alt',
          description: 'Images must have alternative text',
          impact: IssueImpact.CRITICAL,
          pageUrl: 'https://example.com/',
        },
      ],
    });
    // A lazy-loaded image followed a redirect to a blocked address while the
    // evidence (element screenshots) was being collected.
    mockScanner.assertPageAllowed.mockRejectedValue(
      new TargetPolicyViolationError(
        'redirect to blocked target http://10.0.0.5/x.png',
      ),
    );

    await processor.process({ data: { scanId: 1 } } as any);

    expect(mockAgentAudit.collectForPage).toHaveBeenCalledTimes(1);
    expect(mockScanner.assertPageAllowed).toHaveBeenCalled();
    expect(mockIssueRepo.save).not.toHaveBeenCalled();
    // Nothing was buffered, so the AI phase never starts.
    expect(mockAgentAudit.evaluate).not.toHaveBeenCalled();
    expect(mockScanRepo.update).toHaveBeenLastCalledWith(1, {
      status: ScanStatus.COMPLETED,
      pagesDiscovered: 1,
      pagesScanned: 0,
      pagesFailed: 1,
    });
  });

  it('buffers collected evidence only after the page passed the final policy check', async () => {
    mockScanQb.getOne.mockResolvedValue(
      makeScan({ targets: ['https://example.com'] }),
    );
    mockAgentAudit.resolveSkills.mockReturnValue([{ id: 'image_alt_text' }]);
    mockAgentAudit.collectForPage.mockResolvedValue([{ id: 'unit-1' }]);
    (mockAgentAudit as any).remainingScanUnits = jest.fn().mockReturnValue(10);
    mockScanner.scanPage.mockResolvedValue({
      finalUrl: 'https://example.com/',
      issues: [],
    });

    await processor.process({ data: { scanId: 1 } } as any);

    expect(mockAgentAudit.evaluate).toHaveBeenCalledWith(
      expect.anything(),
      [{ id: 'unit-1' }],
      expect.any(Function),
    );
  });

  it('does not mine links from a crawl page that violated the policy after its scan', async () => {
    mockScanQb.getOne.mockResolvedValue(
      makeScan({ mode: ScanMode.CRAWL, targets: ['https://example.com'] }),
    );
    const page = {
      url: jest.fn().mockReturnValue('https://example.com/'),
      evaluate: jest.fn().mockResolvedValue(['https://example.com/about']),
      close: jest.fn().mockResolvedValue(undefined),
    };
    mockContext.newPage.mockResolvedValue(page);
    // Clean while scanning; a timer-driven request reached a blocked target
    // before link discovery.
    mockScanner.assertPageAllowed
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(
        new TargetPolicyViolationError('redirect to blocked target'),
      );
    const enqueueLinks = jest.fn();

    mockCrawlerRunHandler = async ({ requestHandler }) => {
      await requestHandler({
        request: {
          url: 'https://example.com/',
          uniqueKey: 'https://example.com/',
          userData: { depth: 0 },
        },
        enqueueLinks,
      });
    };

    await processor.process({ data: { scanId: 1 } } as any);

    expect(page.evaluate).not.toHaveBeenCalled();
    expect(enqueueLinks).not.toHaveBeenCalled();
  });

  it('counts policy-blocked pages as failed without opening a page', async () => {
    mockScanQb.getOne.mockResolvedValue(
      makeScan({
        mode: ScanMode.URL_LIST,
        targets: ['https://example.com/a', 'https://internal.example/b'],
      }),
    );
    mockUrlPolicy.isAllowedTarget.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('internal')
          ? { allowed: false, reason: 'private range' }
          : { allowed: true },
      ),
    );
    mockScanner.scanPage.mockResolvedValue({
      finalUrl: 'https://example.com/a',
      issues: [],
    });

    await processor.process({ data: { scanId: 1 } } as any);

    expect(mockScanner.scanPage).toHaveBeenCalledTimes(1);
    expect(mockContext.newPage).toHaveBeenCalledTimes(1);
    expect(mockScanRepo.update).toHaveBeenLastCalledWith(1, {
      status: ScanStatus.COMPLETED,
      pagesDiscovered: 2,
      pagesScanned: 1,
      pagesFailed: 1,
    });
  });

  it('marks scan PENDING when a non-final attempt fails', async () => {
    mockScanQb.getOne.mockResolvedValue(makeScan());
    mockBrowserService.getBrowser.mockRejectedValue(
      new Error('browser unavailable'),
    );

    await expect(
      processor.process({
        data: { scanId: 1 },
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as any),
    ).rejects.toThrow('browser unavailable');

    expect(mockScanRepo.update).toHaveBeenLastCalledWith(1, {
      status: ScanStatus.PENDING,
    });
  });

  it('marks scan FAILED only on the final attempt', async () => {
    mockScanQb.getOne.mockResolvedValue(makeScan());
    mockBrowserService.getBrowser.mockRejectedValue(
      new Error('browser unavailable'),
    );

    await expect(
      processor.process({
        data: { scanId: 1 },
        attemptsMade: 2,
        opts: { attempts: 3 },
      } as any),
    ).rejects.toThrow('browser unavailable');

    expect(mockScanRepo.update).toHaveBeenLastCalledWith(1, {
      status: ScanStatus.FAILED,
    });
  });

  it('truncates oversized issue fields and normalizes pageUrl before saving', async () => {
    mockScanQb.getOne.mockResolvedValue(makeScan());
    mockScanner.scanPage.mockResolvedValue({
      finalUrl: 'https://example.com/',
      issues: [
        {
          ruleId: 'color-contrast',
          description: 'd'.repeat(5000),
          impact: IssueImpact.SERIOUS,
          pageUrl: 'https://example.com/page/#section',
          selector: 's'.repeat(5000),
          context: 'c'.repeat(10000),
          helpUrl: 'https://example.com/help',
        },
      ],
    });

    await processor.process({ data: { scanId: 1 } } as any);

    const saved = (mockIssueRepo.save as jest.Mock).mock.calls[0][0][0];
    expect(saved.description.length).toBeLessThanOrEqual(1000);
    expect(saved.selector.length).toBeLessThanOrEqual(1000);
    expect(saved.context.length).toBeLessThanOrEqual(4000);
    // Fragment stripped and trailing slash removed by normalization.
    expect(saved.pageUrl).toBe('https://example.com/page');
  });

  it('decrypts basic auth credentials and passes them to scanner context', async () => {
    mockScanQb.getOne.mockResolvedValue(
      makeScan({
        basicAuthUsernameEncrypted: 'enc-user',
        basicAuthPasswordEncrypted: 'enc-pass',
      }),
    );
    mockBasicAuthCrypto.decryptCredentials.mockReturnValue({
      username: 'scanner-user',
      password: 'scanner-password',
    });
    mockScanner.scanPage.mockResolvedValue({
      finalUrl: 'https://example.com/',
      issues: [],
    });

    await processor.process({ data: { scanId: 1 } } as any);

    expect(mockBasicAuthCrypto.decryptCredentials).toHaveBeenCalledWith(
      'enc-user',
      'enc-pass',
    );
    expect(mockScanner.createContext).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        basicAuth: {
          username: 'scanner-user',
          password: 'scanner-password',
        },
      }),
    );
  });
});
