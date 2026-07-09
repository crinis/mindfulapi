import { join } from 'node:path';
import { DataSource, Repository } from 'typeorm';
import { Job } from 'bullmq';
import { Scan } from '../src/entities/scan.entity';
import { Issue } from '../src/entities/issue.entity';
import { AgentFinding } from '../src/entities/agent-finding.entity';
import { ScanMode } from '../src/enums/scan-mode.enum';
import { ScanStatus } from '../src/enums/scan-status.enum';
import { CrawlStrategy } from '../src/enums/crawl-strategy.enum';
import { BrowserService } from '../src/services/browser.service';
import { AxeAccessibilityScanner } from '../src/services/axe-accessibility-scanner.service';
import { ScanProcessor } from '../src/services/scan.processor';
import { BasicAuthCryptoService } from '../src/services/basic-auth-crypto.service';
import { scanConfig } from '../src/config/configuration';
import { UrlPolicyService } from '../src/services/url-policy.service';
import type { AgentAuditService } from '../src/agent/agent-audit.service';
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
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Scan, Issue, AgentFinding],
      synchronize: true,
    });
    await dataSource.initialize();

    scanRepository = dataSource.getRepository(Scan);
    issueRepository = dataSource.getRepository(Issue);

    browserService = new BrowserService(scanConfig());
    scanner = new AxeAccessibilityScanner(scanConfig());

    // AI audit is disabled here; a no-op stub keeps the deterministic path.
    const agentAudit = {
      resolveSkills: () => [],
      reset: () => Promise.resolve(undefined),
      collectForPage: () => Promise.resolve([]),
      evaluate: () => Promise.resolve(undefined),
    };

    processor = new ScanProcessor(
      scanRepository,
      issueRepository,
      browserService,
      scanner,
      new BasicAuthCryptoService(),
      scanConfig(),
      // Fixture site runs on localhost, which the default policy blocks.
      new UrlPolicyService({ ...scanConfig(), allowPrivateTargets: true }),
      agentAudit as unknown as AgentAuditService,
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
      targets: [indexUrl],
    });

    await processor.process({ data: { scanId: scan.id } } as Job);

    const completed = await scanRepository.findOne({
      where: { id: scan.id },
      relations: { issues: true },
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
      targets: [indexUrl, aboutUrl],
    });

    await processor.process({ data: { scanId: scan.id } } as Job);

    const completed = await scanRepository.findOne({
      where: { id: scan.id },
      relations: { issues: true },
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
      targets: [indexUrl],
      crawlMaxPages: 10,
      crawlMaxDepth: 3,
      crawlStrategy: CrawlStrategy.SameHostname,
      crawlGlobs: null,
      crawlExcludeGlobs: null,
    });

    await processor.process({ data: { scanId: scan.id } } as Job);

    const completed = await scanRepository.findOne({
      where: { id: scan.id },
      relations: { issues: true },
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
      mode: ScanMode.SINGLE_URL,
      targets: [localUrl('/index.html')],
      rootElement: undefined,
      ruleIds: null,
      crawlMaxPages: null,
      crawlMaxDepth: null,
      crawlStrategy: null,
      crawlGlobs: null,
      crawlExcludeGlobs: null,
      status: ScanStatus.PENDING,
      pagesDiscovered: 0,
      pagesScanned: 0,
      pagesFailed: 0,
      ...overrides,
    });

    return scanRepository.save(scan);
  }
});
