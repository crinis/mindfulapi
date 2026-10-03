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
  EnqueueStrategy: jest.requireActual('@crawlee/core').EnqueueStrategy,
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

import { enqueueLinks as crawleeEnqueueLinks } from '@crawlee/core';
import { In } from 'typeorm';
import {
  EVIDENCE_RESERVE_MS,
  PAGE_DEADLINE_MS,
  ScanInterruptedError,
  ScanProcessor,
} from './scan.processor';
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
  reconcileAttempts: 0,
  agentFindings: [],
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

/** Criteria of the processor's guarded COMPLETED write for scan 1. */
const COMPLETION_GUARD = {
  id: 1,
  status: In([ScanStatus.RUNNING, ScanStatus.ANALYZING]),
};

/** Criteria of the processor's guarded PENDING/FAILED write for scan 1. */
const RETRY_GUARD = {
  id: 1,
  status: In([ScanStatus.PENDING, ScanStatus.RUNNING, ScanStatus.ANALYZING]),
};

/** A request the simulated crawler handed to the processor. */
interface SimulatedRequest {
  url: string;
  uniqueKey: string;
  userData: Record<string, unknown>;
}

/**
 * Drives the processor's requestHandler like Crawlee's BasicCrawler, with
 * Crawlee's real `enqueueLinks` (transformRequestFunction first, then the
 * strategy/glob/exclude filters) over an in-memory request queue that keeps
 * Crawlee's `addRequestsBatched` contract: duplicates by `uniqueKey` are
 * reported as already present and never consume the `maxNewRequests` budget.
 *
 * Like BasicCrawler, the crawl stops after `maxRequestsPerCrawl` handled
 * requests, and each enqueue is capped at the requests still allowed
 * (`maxRequestsPerCrawl` minus handled and pending requests).
 */
function simulateCrawl(seeds: string[]) {
  const handled: SimulatedRequest[] = [];
  const enqueueCalls: Array<{ baseUrl?: string; urls: string[] }> = [];
  const pending: SimulatedRequest[] = [];
  const known = new Set<string>();

  const requestQueue = {
    addRequestsBatched: (
      requests: Array<{
        url: string;
        uniqueKey: string;
        userData?: Record<string, unknown>;
      }>,
      options: { maxNewRequests?: number } = {},
    ) => {
      let budget = options.maxNewRequests ?? Infinity;
      const addedRequests: Array<{
        uniqueKey: string;
        requestId: string;
        wasAlreadyPresent: boolean;
        wasAlreadyHandled: boolean;
      }> = [];
      const requestsOverLimit: typeof requests = [];
      for (const request of requests) {
        const wasAlreadyPresent = known.has(request.uniqueKey);
        if (!wasAlreadyPresent && budget <= 0) {
          requestsOverLimit.push(request);
          continue;
        }
        if (!wasAlreadyPresent) {
          budget -= 1;
          known.add(request.uniqueKey);
          pending.push({
            url: request.url,
            uniqueKey: request.uniqueKey,
            userData: request.userData ?? {},
          });
        }
        addedRequests.push({
          uniqueKey: request.uniqueKey,
          requestId: request.uniqueKey,
          wasAlreadyPresent,
          wasAlreadyHandled: false,
        });
      }
      return Promise.resolve({
        addedRequests,
        waitForAllRequestsToBeAdded: Promise.resolve([]),
        requestsOverLimit,
      });
    },
  };

  const run = async ({
    requestHandler,
    maxRequestsPerCrawl = Infinity,
  }: {
    requestHandler: (context: any) => Promise<void>;
    maxRequestsPerCrawl?: number;
  }) => {
    for (const url of seeds) {
      known.add(url);
      pending.push({ url, uniqueKey: url, userData: { depth: 0 } });
    }

    while (pending.length > 0 && handled.length < maxRequestsPerCrawl) {
      const request = pending.shift()!;
      handled.push(request);
      const enqueueLinks = (options: any) => {
        enqueueCalls.push({ baseUrl: options.baseUrl, urls: options.urls });
        return crawleeEnqueueLinks({
          requestQueue,
          // BasicCrawler.calculateEnqueuedRequestLimit: every request known
          // to the queue is either handled, in progress or pending.
          limit: Math.max(0, maxRequestsPerCrawl - known.size),
          ...options,
        });
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
  let mockBrowser: { isConnected: jest.Mock };
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
      // The cancellation check reads the row; a missing row means deleted.
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 1, status: ScanStatus.RUNNING }),
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

    mockBrowser = { isConnected: jest.fn().mockReturnValue(true) };
    mockBrowserService = {
      getBrowser: jest.fn().mockResolvedValue(mockBrowser),
    };

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
    // The partial results a canceled scan keeps are not wiped.
    expect(mockIssueRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(mockAgentAudit.reset).not.toHaveBeenCalled();
  });

  describe('status transitions racing a cancellation', () => {
    /** Answers guarded updates as if the row had been CANCELED meanwhile. */
    const cancelBefore = (status: ScanStatus) => {
      mockScanRepo.update.mockImplementation(
        (criteria: unknown, values: { status?: ScanStatus }) =>
          Promise.resolve({
            affected:
              typeof criteria === 'object' && values.status === status ? 0 : 1,
          }),
      );
    };

    it('does not start the AI audit when the scan was canceled before ANALYZING', async () => {
      mockScanQb.getOne.mockResolvedValue(makeScan());
      mockAgentAudit.resolveSkills.mockReturnValue([{ id: 'image_alt_text' }]);
      mockAgentAudit.collectForPage.mockResolvedValue([{ id: 'unit-1' }]);
      (mockAgentAudit as any).remainingScanUnits = jest
        .fn()
        .mockReturnValue(10);
      cancelBefore(ScanStatus.ANALYZING);

      await processor.process({ data: { scanId: 1 } } as any);

      expect(mockScanRepo.update).toHaveBeenCalledWith(
        { id: 1, status: ScanStatus.RUNNING },
        { status: ScanStatus.ANALYZING },
      );
      expect(mockAgentAudit.evaluate).not.toHaveBeenCalled();
      expect(mockScanRepo.update).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: ScanStatus.COMPLETED }),
      );
    });

    it('completes only a scan that is still running or analyzing', async () => {
      mockScanQb.getOne.mockResolvedValue(makeScan());

      await processor.process({ data: { scanId: 1 } } as any);

      expect(mockScanRepo.update).toHaveBeenLastCalledWith(
        { id: 1, status: In([ScanStatus.RUNNING, ScanStatus.ANALYZING]) },
        {
          status: ScanStatus.COMPLETED,
          pagesDiscovered: 1,
          pagesScanned: 1,
          pagesFailed: 0,
        },
      );
    });

    it('neither retries nor revives a canceled scan whose attempt failed', async () => {
      mockScanQb.getOne.mockResolvedValue(makeScan());
      mockBrowserService.getBrowser.mockRejectedValue(
        new Error('browser unavailable'),
      );
      mockScanRepo.findOne.mockResolvedValue({
        id: 1,
        status: ScanStatus.CANCELED,
      });

      await expect(
        processor.process({
          data: { scanId: 1 },
          attemptsMade: 0,
          opts: { attempts: 3 },
        } as any),
      ).resolves.toBeUndefined();

      expect(mockScanRepo.update).not.toHaveBeenCalledWith(expect.anything(), {
        status: ScanStatus.PENDING,
      });
    });

    it('writes PENDING after a failed attempt only over an active status', async () => {
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

      expect(mockScanRepo.update).toHaveBeenLastCalledWith(
        {
          id: 1,
          status: In([
            ScanStatus.PENDING,
            ScanStatus.RUNNING,
            ScanStatus.ANALYZING,
          ]),
        },
        { status: ScanStatus.PENDING },
      );
    });
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
      mockBrowser,
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
    expect(mockScanRepo.update).toHaveBeenLastCalledWith(COMPLETION_GUARD, {
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
    expect(mockScanRepo.update).toHaveBeenLastCalledWith(COMPLETION_GUARD, {
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
    expect(mockScanRepo.update).toHaveBeenLastCalledWith(COMPLETION_GUARD, {
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
      expect(mockScanRepo.update).toHaveBeenLastCalledWith(COMPLETION_GUARD, {
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
      expect(mockScanRepo.update).toHaveBeenLastCalledWith(COMPLETION_GUARD, {
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
      expect(mockScanRepo.update).toHaveBeenLastCalledWith(COMPLETION_GUARD, {
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

  describe('crawl link budget', () => {
    /** Serves `links[url]` as the hrefs of each page; every page loads as requested. */
    const serveLinks = (links: Record<string, string[]>) => {
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
          page.currentUrl = url;
          return Promise.resolve({ finalUrl: url, status: 200 });
        },
      );
    };

    const range = (count: number, url: (i: number) => string) =>
      Array.from({ length: count }, (_, i) => url(i));

    it('spends the page budget only on links that pass the strategy filter', async () => {
      mockScanQb.getOne.mockResolvedValue(
        makeScan({
          mode: ScanMode.CRAWL,
          targets: ['https://example.com'],
          crawlMaxPages: 10,
          crawlMaxDepth: 3,
          crawlStrategy: CrawlStrategy.SameHostname,
        }),
      );
      const internal = range(5, (i) => `https://example.com/page-${i}`);
      serveLinks({
        'https://example.com/': [
          ...range(300, (i) => `https://partner-${i}.example.net/`),
          ...internal,
        ],
      });
      const crawl = simulateCrawl(['https://example.com/']);
      mockCrawlerRunHandler = crawl.run;

      await processor.process({ data: { scanId: 1 } } as any);

      expect(crawl.handled.map((r) => r.url)).toEqual([
        'https://example.com/',
        ...internal,
      ]);
      expect(mockScanRepo.update).toHaveBeenLastCalledWith(COMPLETION_GUARD, {
        status: ScanStatus.COMPLETED,
        pagesDiscovered: 6,
        pagesScanned: 6,
        pagesFailed: 0,
      });
    });

    it('spends the page budget only on links that match the globs', async () => {
      mockScanQb.getOne.mockResolvedValue(
        makeScan({
          mode: ScanMode.CRAWL,
          targets: ['https://example.com'],
          crawlMaxPages: 10,
          crawlMaxDepth: 3,
          crawlStrategy: CrawlStrategy.SameHostname,
          crawlGlobs: ['https://example.com/docs/**'],
        }),
      );
      const docs = range(5, (i) => `https://example.com/docs/page-${i}`);
      serveLinks({
        'https://example.com/': [
          ...range(300, (i) => `https://example.com/blog/post-${i}`),
          ...docs,
        ],
      });
      const crawl = simulateCrawl(['https://example.com/']);
      mockCrawlerRunHandler = crawl.run;

      await processor.process({ data: { scanId: 1 } } as any);

      expect(crawl.handled.map((r) => r.url)).toEqual([
        'https://example.com/',
        ...docs,
      ]);
    });

    it('still follows a link from its own seed after another seed filtered it out', async () => {
      mockScanQb.getOne.mockResolvedValue(
        makeScan({
          mode: ScanMode.CRAWL,
          targets: ['https://example.com', 'https://other.example.org'],
          crawlMaxPages: 10,
          crawlMaxDepth: 3,
          crawlStrategy: CrawlStrategy.SameHostname,
        }),
      );
      serveLinks({
        'https://example.com/': ['https://other.example.org/shared'],
        'https://other.example.org/': ['https://other.example.org/shared'],
      });
      const crawl = simulateCrawl([
        'https://example.com/',
        'https://other.example.org/',
      ]);
      mockCrawlerRunHandler = crawl.run;

      await processor.process({ data: { scanId: 1 } } as any);

      expect(crawl.handled.map((r) => r.url)).toEqual([
        'https://example.com/',
        'https://other.example.org/',
        'https://other.example.org/shared',
      ]);
    });

    it('stops at maxPages and passes each in-scope link to the queue once', async () => {
      mockScanQb.getOne.mockResolvedValue(
        makeScan({
          mode: ScanMode.CRAWL,
          targets: ['https://example.com'],
          crawlMaxPages: 6,
          crawlMaxDepth: 3,
          crawlStrategy: CrawlStrategy.SameHostname,
        }),
      );
      const nav = range(4, (i) => `https://example.com/section-${i}`);
      serveLinks({
        'https://example.com/': nav,
        [nav[0]]: [
          ...nav,
          'https://example.com/section-0/#top',
          'https://example.com/extra',
        ],
        [nav[1]]: [...nav, 'https://example.com/too-late'],
      });
      const crawl = simulateCrawl(['https://example.com/']);
      mockCrawlerRunHandler = crawl.run;

      await processor.process({ data: { scanId: 1 } } as any);

      expect(crawl.handled.map((r) => r.url)).toEqual([
        'https://example.com/',
        ...nav,
        'https://example.com/extra',
      ]);
      // Links already in the queue are not offered again (Crawlee would add
      // them in budget-sized batches, sleeping a second between batches), and
      // a full queue is not mined for links at all.
      expect(crawl.enqueueCalls.map((call) => call.urls)).toEqual([
        nav,
        ['https://example.com/extra'],
      ]);
    });
  });

  it('counts a page Crawlee failed (handler error or timeout) as discovered and failed', async () => {
    mockScanQb.getOne.mockResolvedValue(
      makeScan({
        mode: ScanMode.CRAWL,
        targets: ['https://example.com'],
      }),
    );

    mockCrawlerRunHandler = async ({ failedRequestHandler }) => {
      if (failedRequestHandler) {
        await (failedRequestHandler as any)(
          {
            request: {
              url: 'https://example.com/failed',
              uniqueKey: 'https://example.com/failed',
              userData: { depth: 1 },
            },
          },
          new Error('browser has been closed'),
        );
      }
    };

    await processor.process({ data: { scanId: 1 } } as any);

    expect(mockScanRepo.update).toHaveBeenLastCalledWith(COMPLETION_GUARD, {
      status: ScanStatus.COMPLETED,
      pagesDiscovered: 1,
      pagesScanned: 0,
      pagesFailed: 1,
    });
  });

  describe('crawl request lifecycle', () => {
    const seed = {
      url: 'https://example.com/',
      uniqueKey: 'https://example.com/',
      userData: { depth: 0 },
    };
    const issue = {
      ruleId: 'image-alt',
      description: 'Images must have alternative text',
      impact: IssueImpact.CRITICAL,
      pageUrl: 'https://example.com/',
    };

    beforeEach(() => {
      mockScanQb.getOne.mockResolvedValue(
        makeScan({ mode: ScanMode.CRAWL, targets: ['https://example.com'] }),
      );
    });

    it('never retries a page and lets the page deadline fire before the handler timeout', async () => {
      let crawlerOptions: any;
      mockCrawlerRunHandler = (options) => {
        crawlerOptions = options;
        return Promise.resolve();
      };

      await processor.process({ data: { scanId: 1 } } as any);

      // Crawlee's timeout rejects but never stops the handler, and every
      // retry would run alongside it: retries would scan a slow page in
      // parallel, up to four times.
      expect(crawlerOptions.maxRequestRetries).toBe(0);
      expect(crawlerOptions.requestHandlerTimeoutSecs * 1000).toBeGreaterThan(
        PAGE_DEADLINE_MS,
      );
    });

    it('discards a page Crawlee gave up on while its handler was still running', async () => {
      let finishAnalysis!: () => void;
      mockScanner.analyzeLoadedPage.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishAnalysis = () =>
              resolve({ finalUrl: 'https://example.com/', issues: [issue] });
          }),
      );
      mockCrawlerRunHandler = async ({
        requestHandler,
        failedRequestHandler,
      }) => {
        const handling = requestHandler({
          request: seed,
          enqueueLinks: jest.fn(),
        });
        while (!finishAnalysis) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        // Crawlee's requestHandlerTimeoutSecs fired: the request is failed
        // while the handler keeps running.
        await (failedRequestHandler as any)(
          { request: seed },
          new Error('requestHandler timed out'),
        );
        finishAnalysis();
        await handling;
      };

      await processor.process({ data: { scanId: 1 } } as any);

      expect(mockIssueRepo.save).not.toHaveBeenCalled();
      expect(mockScanRepo.update).toHaveBeenLastCalledWith(COMPLETION_GUARD, {
        status: ScanStatus.COMPLETED,
        pagesDiscovered: 1,
        pagesScanned: 0,
        pagesFailed: 1,
      });
    });

    it('stores and counts a request handled twice only once', async () => {
      mockScanner.analyzeLoadedPage.mockResolvedValue({
        finalUrl: 'https://example.com/',
        issues: [issue],
      });
      mockCrawlerRunHandler = async ({ requestHandler }) => {
        await requestHandler({ request: seed, enqueueLinks: jest.fn() });
        await requestHandler({ request: seed, enqueueLinks: jest.fn() });
      };

      await processor.process({ data: { scanId: 1 } } as any);

      expect(mockIssueRepo.save).toHaveBeenCalledTimes(1);
      expect(mockScanRepo.update).toHaveBeenLastCalledWith(COMPLETION_GUARD, {
        status: ScanStatus.COMPLETED,
        pagesDiscovered: 1,
        pagesScanned: 1,
        pagesFailed: 0,
      });
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
    expect(mockScanRepo.update).toHaveBeenLastCalledWith(COMPLETION_GUARD, {
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
    expect(mockScanRepo.update).toHaveBeenLastCalledWith(COMPLETION_GUARD, {
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
    expect(mockScanRepo.update).toHaveBeenLastCalledWith(COMPLETION_GUARD, {
      status: ScanStatus.COMPLETED,
      pagesDiscovered: 2,
      pagesScanned: 1,
      pagesFailed: 1,
    });
  });

  it.each([ScanMode.SINGLE_URL, ScanMode.CRAWL])(
    'scopes AI evidence of a %s scan to its root element',
    async (mode) => {
      mockScanQb.getOne.mockResolvedValue(
        makeScan({ mode, rootElement: 'main', crawlMaxDepth: 0 }),
      );
      mockAgentAudit.resolveSkills.mockReturnValue([{ id: 'page_title' }]);
      if (mode === ScanMode.CRAWL) {
        mockCrawlerRunHandler = simulateCrawl(['https://example.com/']).run;
      }

      await processor.process({ data: { scanId: 1 } } as any);

      expect(mockAgentAudit.collectForPage).toHaveBeenCalledTimes(1);
      expect(mockAgentAudit.collectForPage.mock.calls[0][5]).toMatchObject({
        rootElement: 'main',
      });
    },
  );

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
    expect(mockScanRepo.update).toHaveBeenLastCalledWith(COMPLETION_GUARD, {
      status: ScanStatus.COMPLETED,
      pagesDiscovered: 1,
      pagesScanned: 0,
      pagesFailed: 1,
    });
  });

  it('collects AI evidence under the normalized page URL its issues are stored under', async () => {
    mockScanQb.getOne.mockResolvedValue(
      makeScan({ targets: ['https://example.com/de/'] }),
    );
    mockAgentAudit.resolveSkills.mockReturnValue([{ id: 'page_title' }]);
    (mockAgentAudit as any).remainingScanUnits = jest.fn().mockReturnValue(10);
    // The browser lands on the trailing-slash URL.
    mockScanner.scanPage.mockResolvedValue({
      finalUrl: 'https://example.com/de/',
      issues: [
        {
          ruleId: 'image-alt',
          description: 'Images must have alternative text',
          impact: IssueImpact.CRITICAL,
          pageUrl: 'https://example.com/de/',
        },
      ],
    });

    await processor.process({ data: { scanId: 1 } } as any);

    expect(mockAgentAudit.collectForPage.mock.calls[0][2]).toBe(
      'https://example.com/de',
    );
    expect((mockIssueRepo.save as jest.Mock).mock.calls[0][0][0].pageUrl).toBe(
      'https://example.com/de',
    );
  });

  it('collects crawl-page evidence under the normalized page URL', async () => {
    mockScanQb.getOne.mockResolvedValue(
      makeScan({ mode: ScanMode.CRAWL, targets: ['https://example.com/de/'] }),
    );
    mockAgentAudit.resolveSkills.mockReturnValue([{ id: 'page_title' }]);
    (mockAgentAudit as any).remainingScanUnits = jest.fn().mockReturnValue(10);
    mockScanner.openPage.mockResolvedValue({
      finalUrl: 'https://example.com/de/',
      status: 200,
    });
    mockCrawlerRunHandler = simulateCrawl(['https://example.com/de']).run;

    await processor.process({ data: { scanId: 1 } } as any);

    expect(mockAgentAudit.collectForPage.mock.calls[0][2]).toBe(
      'https://example.com/de',
    );
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

  describe('per-page deadline', () => {
    beforeEach(() => {
      jest.useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
      });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    /** A page whose `closed` promise settles once the page is closed. */
    const closablePage = (url = 'https://example.com/') => {
      let markClosed!: () => void;
      const page = {
        url: jest.fn().mockReturnValue(url),
        evaluate: jest.fn().mockResolvedValue(['https://example.com/next']),
        close: jest.fn(() => {
          markClosed();
          return Promise.resolve();
        }),
        closed: new Promise<void>((resolve) => {
          markClosed = resolve;
        }),
      };
      return page;
    };
    type ClosablePage = ReturnType<typeof closablePage>;

    /** Runs a job while letting the page deadline elapse. */
    const processPastDeadline = async () => {
      const run = processor.process({ data: { scanId: 1 } } as any);
      await jest.advanceTimersByTimeAsync(PAGE_DEADLINE_MS);
      await run;
    };

    it('fails a page whose analysis never settles, closes it and scans the rest', async () => {
      mockScanQb.getOne.mockResolvedValue(
        makeScan({
          mode: ScanMode.URL_LIST,
          targets: ['https://example.com/busy', 'https://example.com/fine'],
        }),
      );
      const pages: ClosablePage[] = [];
      mockContext.newPage.mockImplementation(() => {
        const page = closablePage();
        pages.push(page);
        return Promise.resolve(page);
      });
      mockScanner.scanPage.mockImplementation((_page: unknown, url: string) =>
        url.endsWith('/busy')
          ? new Promise(() => undefined)
          : Promise.resolve({ finalUrl: url, issues: [] }),
      );

      await processPastDeadline();

      expect(pages[0].close).toHaveBeenCalled();
      expect(mockScanRepo.update).toHaveBeenLastCalledWith(COMPLETION_GUARD, {
        status: ScanStatus.COMPLETED,
        pagesDiscovered: 2,
        pagesScanned: 1,
        pagesFailed: 1,
      });
    });

    it.each([ScanMode.SINGLE_URL, ScanMode.CRAWL])(
      'gives the AI evidence of a %s page a budget that ends before the page deadline',
      async (mode) => {
        mockScanQb.getOne.mockResolvedValue(
          makeScan({ mode, crawlMaxDepth: 0 }),
        );
        mockAgentAudit.resolveSkills.mockReturnValue([{ id: 'page_title' }]);
        if (mode === ScanMode.CRAWL) {
          mockCrawlerRunHandler = simulateCrawl(['https://example.com/']).run;
        }
        // Fake time stands still while the job runs without timers.
        const started = Date.now();

        await processor.process({ data: { scanId: 1 } } as any);

        expect(mockAgentAudit.collectForPage).toHaveBeenCalledTimes(1);
        expect(mockAgentAudit.collectForPage.mock.calls[0][5]).toMatchObject({
          deadline: started + PAGE_DEADLINE_MS - EVIDENCE_RESERVE_MS,
        });
      },
    );

    it('discards what a page produces after its deadline expired', async () => {
      mockScanQb.getOne.mockResolvedValue(makeScan());
      mockAgentAudit.resolveSkills.mockReturnValue([{ id: 'image_alt_text' }]);
      (mockAgentAudit as any).remainingScanUnits = jest
        .fn()
        .mockReturnValue(10);
      const page = closablePage();
      mockContext.newPage.mockResolvedValue(page);
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
      // Screenshots of a page whose main thread is busy hang until the page
      // closes; the collection then finishes with what it had.
      mockAgentAudit.collectForPage.mockImplementation(() =>
        page.closed.then(() => [{ id: 'late-unit' }]),
      );

      await processPastDeadline();

      expect(page.close).toHaveBeenCalled();
      expect(mockIssueRepo.save).not.toHaveBeenCalled();
      expect(mockAgentAudit.evaluate).not.toHaveBeenCalled();
      expect(mockScanRepo.update).toHaveBeenLastCalledWith(COMPLETION_GUARD, {
        status: ScanStatus.COMPLETED,
        pagesDiscovered: 1,
        pagesScanned: 0,
        pagesFailed: 1,
      });
    });

    it('fails a crawl page that hangs during analysis without mining its links', async () => {
      mockScanQb.getOne.mockResolvedValue(
        makeScan({ mode: ScanMode.CRAWL, targets: ['https://example.com'] }),
      );
      const page = closablePage();
      mockContext.newPage.mockResolvedValue(page);
      mockScanner.analyzeLoadedPage.mockReturnValue(
        new Promise(() => undefined),
      );
      const crawl = simulateCrawl(['https://example.com/']);
      mockCrawlerRunHandler = crawl.run;

      await processPastDeadline();

      expect(page.close).toHaveBeenCalled();
      expect(page.evaluate).not.toHaveBeenCalled();
      expect(crawl.enqueueCalls).toEqual([]);
      expect(mockScanRepo.update).toHaveBeenLastCalledWith(COMPLETION_GUARD, {
        status: ScanStatus.COMPLETED,
        pagesDiscovered: 1,
        pagesScanned: 0,
        pagesFailed: 1,
      });
    });

    it('covers link extraction too', async () => {
      mockScanQb.getOne.mockResolvedValue(
        makeScan({ mode: ScanMode.CRAWL, targets: ['https://example.com'] }),
      );
      const page = closablePage();
      page.evaluate.mockReturnValue(new Promise(() => undefined));
      mockContext.newPage.mockResolvedValue(page);
      const crawl = simulateCrawl(['https://example.com/']);
      mockCrawlerRunHandler = crawl.run;

      await processPastDeadline();

      expect(page.close).toHaveBeenCalled();
      expect(mockScanRepo.update).toHaveBeenLastCalledWith(COMPLETION_GUARD, {
        status: ScanStatus.COMPLETED,
        pagesDiscovered: 1,
        pagesScanned: 0,
        pagesFailed: 1,
      });
    });

    it('leaves a page that finishes in time alone', async () => {
      mockScanQb.getOne.mockResolvedValue(makeScan());
      const page = closablePage();
      mockContext.newPage.mockResolvedValue(page);
      mockScanner.scanPage.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () => resolve({ finalUrl: 'https://example.com/', issues: [] }),
              PAGE_DEADLINE_MS - 1000,
            );
          }),
      );

      await processPastDeadline();

      expect(page.close).toHaveBeenCalledTimes(1);
      expect(mockScanRepo.update).toHaveBeenLastCalledWith(COMPLETION_GUARD, {
        status: ScanStatus.COMPLETED,
        pagesDiscovered: 1,
        pagesScanned: 1,
        pagesFailed: 0,
      });
    });
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
    expect(mockScanRepo.update).toHaveBeenLastCalledWith(COMPLETION_GUARD, {
      status: ScanStatus.COMPLETED,
      pagesDiscovered: 2,
      pagesScanned: 1,
      pagesFailed: 1,
    });
  });

  describe('deleted scans', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('stops loading pages once the scan row is gone', async () => {
      mockScanQb.getOne.mockResolvedValue(
        makeScan({
          mode: ScanMode.URL_LIST,
          targets: [
            'https://example.com/a',
            'https://example.com/b',
            'https://example.com/c',
          ],
        }),
      );
      processor = new ScanProcessor(
        mockScanRepo as any,
        mockIssueRepo as any,
        mockBrowserService as any,
        mockScanner as any,
        mockBasicAuthCrypto as any,
        { ...scanConfig(), crawlConcurrency: 1 },
        mockUrlPolicy as any,
        mockAgentAudit as any,
      );
      // The row exists for the first page and is deleted while it loads.
      mockScanRepo.findOne.mockResolvedValueOnce({
        id: 1,
        status: ScanStatus.RUNNING,
      });
      mockScanRepo.findOne.mockResolvedValue(null);
      // Pages take longer than the cancellation check's cache window.
      let now = Date.now();
      jest.spyOn(Date, 'now').mockImplementation(() => (now += 3000));

      await processor.process({ data: { scanId: 1 } } as any);

      expect(mockScanner.scanPage).toHaveBeenCalledTimes(1);
      expect(mockScanRepo.update).not.toHaveBeenCalledWith(
        1,
        expect.objectContaining({ status: ScanStatus.COMPLETED }),
      );
    });

    it('does not start the AI audit of a deleted scan', async () => {
      mockScanQb.getOne.mockResolvedValue(makeScan());
      mockAgentAudit.resolveSkills.mockReturnValue([{ id: 'image_alt_text' }]);
      mockAgentAudit.collectForPage.mockResolvedValue([{ id: 'unit-1' }]);
      (mockAgentAudit as any).remainingScanUnits = jest
        .fn()
        .mockReturnValue(10);
      // Deleted while its page was being scanned.
      mockScanRepo.findOne.mockResolvedValue(null);

      await processor.process({ data: { scanId: 1 } } as any);

      expect(mockAgentAudit.evaluate).not.toHaveBeenCalled();
      expect(mockScanRepo.update).not.toHaveBeenCalledWith(
        1,
        expect.objectContaining({ status: ScanStatus.ANALYZING }),
      );
    });
  });

  describe('browser lost mid-scan', () => {
    const firstAttempt = {
      data: { scanId: 1 },
      attemptsMade: 0,
      opts: { attempts: 3 },
    };

    /** The browser goes away while the given page is loading. */
    const loseBrowserDuring = (mock: jest.Mock, url?: string) => {
      mock.mockImplementation((_page: unknown, pageUrl: string) => {
        if (url && pageUrl !== url) {
          return Promise.resolve({
            finalUrl: pageUrl,
            issues: [],
            status: 200,
          });
        }
        mockBrowser.isConnected.mockReturnValue(false);
        return Promise.reject(
          new Error('Target page, context or browser has been closed'),
        );
      });
    };

    const statusWrites = () =>
      mockScanRepo.update.mock.calls
        .map(([, values]) => (values as { status?: ScanStatus }).status)
        .filter(Boolean);

    it('fails the attempt retryably instead of completing a single_url scan', async () => {
      mockScanQb.getOne.mockResolvedValue(makeScan());
      loseBrowserDuring(mockScanner.scanPage);

      await expect(processor.process(firstAttempt as any)).rejects.toThrow(
        ScanInterruptedError,
      );

      expect(statusWrites()).toEqual([ScanStatus.RUNNING, ScanStatus.PENDING]);
    });

    it('stops starting pages once the browser is gone', async () => {
      mockScanQb.getOne.mockResolvedValue(
        makeScan({
          mode: ScanMode.URL_LIST,
          targets: [
            'https://example.com/a',
            'https://example.com/b',
            'https://example.com/c',
          ],
        }),
      );
      const config = { ...scanConfig(), crawlConcurrency: 1 };
      processor = new ScanProcessor(
        mockScanRepo as any,
        mockIssueRepo as any,
        mockBrowserService as any,
        mockScanner as any,
        mockBasicAuthCrypto as any,
        config,
        mockUrlPolicy as any,
        mockAgentAudit as any,
      );
      loseBrowserDuring(mockScanner.scanPage, 'https://example.com/a');

      await expect(processor.process(firstAttempt as any)).rejects.toThrow(
        ScanInterruptedError,
      );

      expect(mockContext.newPage).toHaveBeenCalledTimes(1);
    });

    it('fails the attempt retryably instead of completing a crawl', async () => {
      mockScanQb.getOne.mockResolvedValue(
        makeScan({ mode: ScanMode.CRAWL, targets: ['https://example.com'] }),
      );
      loseBrowserDuring(mockScanner.openPage);
      mockCrawlerRunHandler = simulateCrawl(['https://example.com/']).run;

      await expect(processor.process(firstAttempt as any)).rejects.toThrow(
        ScanInterruptedError,
      );

      expect(statusWrites()).toEqual([ScanStatus.RUNNING, ScanStatus.PENDING]);
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

    expect(mockScanRepo.update).toHaveBeenLastCalledWith(RETRY_GUARD, {
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

    expect(mockScanRepo.update).toHaveBeenLastCalledWith(RETRY_GUARD, {
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
      mockBrowser,
      expect.objectContaining({
        basicAuth: {
          username: 'scanner-user',
          password: 'scanner-password',
          origin: 'https://example.com',
        },
      }),
    );
  });

  it('scopes basic auth to the first target origin and warns about the others', async () => {
    mockScanQb.getOne.mockResolvedValue(
      makeScan({
        mode: ScanMode.URL_LIST,
        targets: [
          'https://staging.example.com:8443/de/',
          'https://staging.example.com:8443/en/',
          'https://cdn.example.com/page',
        ],
        basicAuthUsernameEncrypted: 'enc-user',
        basicAuthPasswordEncrypted: 'enc-pass',
      }),
    );
    mockBasicAuthCrypto.decryptCredentials.mockReturnValue({
      username: 'scanner-user',
      password: 'scanner-password',
    });
    const warn = jest
      .spyOn((processor as any).logger, 'warn')
      .mockImplementation(() => undefined);

    await processor.process({ data: { scanId: 1 } } as any);

    expect(mockScanner.createContext).toHaveBeenCalledWith(
      mockBrowser,
      expect.objectContaining({
        basicAuth: expect.objectContaining({
          origin: 'https://staging.example.com:8443',
        }),
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('https://cdn.example.com'),
    );
  });
});
