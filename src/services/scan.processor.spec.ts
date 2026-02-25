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

const makeScan = (overrides: Partial<Scan> = {}): Scan =>
  ({
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
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }) as Scan;

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
  };
  let mockBasicAuthCrypto: jest.Mocked<
    Pick<BasicAuthCryptoService, 'decryptCredentials'>
  >;
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
      update: jest.fn().mockResolvedValue(undefined),
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
      scanPage: jest.fn(),
    };
    mockBasicAuthCrypto = {
      decryptCredentials: jest.fn(),
    };

    processor = new ScanProcessor(
      mockScanRepo as any,
      mockIssueRepo as any,
      mockBrowserService as any,
      mockScanner as any,
      mockBasicAuthCrypto as any,
    );
  });

  it('throws when scan does not exist', async () => {
    mockScanQb.getOne.mockResolvedValue(null);

    await expect(
      processor.process({ data: { scanId: 999 } } as any),
    ).rejects.toThrow('Scan 999 not found');
    expect(mockScanRepo.update).not.toHaveBeenCalled();
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

    // Return different pages per newPage() call so we can track URLs
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

    mockScanner.scanPage.mockImplementation(
      (_page: unknown, pageUrl: string) => ({
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

    mockCrawlerRunHandler = async ({ requestHandler }) => {
      const pending: any[] = [
        {
          url: 'https://example.com/',
          uniqueKey: 'https://example.com/',
          userData: { depth: 0 },
        },
      ];

      const processRequest = async (request: any) => {
        const enqueueLinks = (options: any) => {
          for (const href of options.urls || []) {
            // Simulate Crawlee strategy filtering
            if (
              options.strategy === 'same-hostname' &&
              new URL(href).hostname !==
                new URL(options.baseUrl ?? request.url).hostname
            ) {
              continue;
            }
            // Simulate Crawlee glob filtering (simplified: check if url includes glob prefix)
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
              userData: {},
            });
            if (transformed) {
              pending.push({ ...transformed, loadedUrl: transformed.url });
            }
          }
        };

        await requestHandler({ request, enqueueLinks });
      };

      while (pending.length > 0) {
        const next = pending.shift();
        await processRequest(next);
      }
    };

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
    expect(mockScanner.scanPage).toHaveBeenCalledTimes(2);
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

    mockScanner.scanPage.mockResolvedValue({
      finalUrl: 'https://example.com/',
      issues: [],
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

    expect(mockScanner.scanPage).toHaveBeenCalledTimes(1);
    expect(mockScanRepo.update).toHaveBeenLastCalledWith(1, {
      status: ScanStatus.COMPLETED,
      pagesDiscovered: 1,
      pagesScanned: 1,
      pagesFailed: 0,
    });
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
