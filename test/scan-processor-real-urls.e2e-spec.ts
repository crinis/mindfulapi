import { join } from 'node:path';
import { DataSource, Repository } from 'typeorm';
import { Job } from 'bullmq';
import { Scan } from '../src/entities/scan.entity';
import { Issue } from '../src/entities/issue.entity';
import { ScanMode } from '../src/enums/scan-mode.enum';
import { ScanStatus } from '../src/enums/scan-status.enum';
import { BrowserService } from '../src/services/browser.service';
import { AxeAccessibilityScanner } from '../src/services/axe-accessibility-scanner.service';
import { ScanProcessor } from '../src/services/scan.processor';
import {
  FixtureSiteServer,
  startFixtureSiteServer,
} from './helpers/fixture-site-server';

describe('ScanProcessor real URL integration', () => {
  jest.setTimeout(120000);

  let fixtureSite: FixtureSiteServer;
  let dataSource: DataSource;
  let scanRepository: Repository<Scan>;
  let issueRepository: Repository<Issue>;
  let browserService: BrowserService;
  let scanner: AxeAccessibilityScanner;
  let processor: ScanProcessor;

  const localUrl = (path: string): string => `${fixtureSite.baseUrl}${path}`;

  beforeAll(async () => {
    fixtureSite = await startFixtureSiteServer(
      join(__dirname, 'fixtures', 'site'),
    );

    dataSource = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [Scan, Issue],
      synchronize: true,
    });
    await dataSource.initialize();

    scanRepository = dataSource.getRepository(Scan);
    issueRepository = dataSource.getRepository(Issue);

    browserService = new BrowserService();
    scanner = new AxeAccessibilityScanner();

    processor = new ScanProcessor(
      scanRepository,
      issueRepository,
      browserService,
      scanner,
    );
  });

  afterAll(async () => {
    await browserService.onApplicationShutdown('test teardown');
    await dataSource.destroy();
    await fixtureSite.close();
  });

  beforeEach(async () => {
    await issueRepository.clear();
    await scanRepository.clear();
  });

  it('processes single_url against a real local URL', async () => {
    const indexUrl = localUrl('/index.html');
    const scan = await createPendingScan({
      mode: ScanMode.SINGLE_URL,
      url: indexUrl,
      targets: [indexUrl],
    });

    await processor.process({ data: { scanId: scan.id } } as Job);

    const completed = await scanRepository.findOne({
      where: { id: scan.id },
      relations: ['issues'],
    });

    expect(completed).toBeTruthy();
    expect(completed?.status).toBe(ScanStatus.COMPLETED);
    expect(completed?.pagesDiscovered).toBe(1);
    expect(completed?.pagesScanned).toBe(1);
    expect(completed?.pagesFailed).toBe(0);
    expect(completed?.issues.length).toBeGreaterThan(0);
    expect(
      completed?.issues.some((issue) => issue.ruleId === 'image-alt'),
    ).toBe(true);
    expect(
      completed?.issues.every((issue) =>
        issue.pageUrl?.startsWith(fixtureSite.baseUrl),
      ),
    ).toBe(true);
  });

  it('processes url_list against multiple real local URLs', async () => {
    const indexUrl = localUrl('/index.html');
    const aboutUrl = localUrl('/about.html');
    const scan = await createPendingScan({
      mode: ScanMode.URL_LIST,
      url: indexUrl,
      targets: [indexUrl, aboutUrl],
    });

    await processor.process({ data: { scanId: scan.id } } as Job);

    const completed = await scanRepository.findOne({
      where: { id: scan.id },
      relations: ['issues'],
    });

    expect(completed).toBeTruthy();
    expect(completed?.status).toBe(ScanStatus.COMPLETED);
    expect(completed?.pagesDiscovered).toBe(2);
    expect(completed?.pagesScanned).toBe(2);
    expect(completed?.pagesFailed).toBe(0);

    const issuePageUrls = new Set(
      completed?.issues.map((issue) => issue.pageUrl).filter(Boolean),
    );

    expect(issuePageUrls.has(indexUrl)).toBe(true);
    expect(issuePageUrls.has(aboutUrl)).toBe(true);
  });

  it('processes crawl mode and discovers linked local pages', async () => {
    const indexUrl = localUrl('/index.html');
    const aboutUrl = localUrl('/about.html');
    const contactUrl = localUrl('/nested/contact.html');

    const scan = await createPendingScan({
      mode: ScanMode.CRAWL,
      url: indexUrl,
      targets: [indexUrl],
      crawlMaxPages: 10,
      crawlMaxDepth: 3,
      crawlSameHostOnly: true,
      crawlIncludePatterns: null,
      crawlExcludePatterns: null,
      crawlConcurrency: 2,
    });

    await processor.process({ data: { scanId: scan.id } } as Job);

    const completed = await scanRepository.findOne({
      where: { id: scan.id },
      relations: ['issues'],
    });

    expect(completed).toBeTruthy();
    expect(completed?.status).toBe(ScanStatus.COMPLETED);
    expect((completed?.pagesDiscovered || 0) >= 3).toBe(true);
    expect((completed?.pagesScanned || 0) >= 3).toBe(true);
    expect(completed?.pagesFailed).toBe(0);

    const issuePageUrls = new Set(
      completed?.issues.map((issue) => issue.pageUrl).filter(Boolean),
    );

    expect(issuePageUrls.has(indexUrl)).toBe(true);
    expect(issuePageUrls.has(aboutUrl)).toBe(true);
    expect(issuePageUrls.has(contactUrl)).toBe(true);
    expect(
      completed?.issues.every(
        (issue) =>
          issue.pageUrl?.startsWith(fixtureSite.baseUrl) &&
          issue.pageUrl?.includes('example.org') !== true,
      ),
    ).toBe(true);
  });

  async function createPendingScan(overrides: Partial<Scan>): Promise<Scan> {
    const scan = scanRepository.create({
      url: localUrl('/index.html'),
      mode: ScanMode.SINGLE_URL,
      targets: [localUrl('/index.html')],
      rootElement: undefined,
      ruleIds: null,
      crawlMaxPages: null,
      crawlMaxDepth: null,
      crawlSameHostOnly: null,
      crawlIncludePatterns: null,
      crawlExcludePatterns: null,
      crawlConcurrency: null,
      status: ScanStatus.PENDING,
      pagesDiscovered: 0,
      pagesScanned: 0,
      pagesFailed: 0,
      ...overrides,
    });

    return scanRepository.save(scan);
  }
});
