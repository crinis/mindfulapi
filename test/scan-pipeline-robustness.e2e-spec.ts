/**
 * Real-browser coverage for scan-pipeline robustness: pages that never let the
 * analysis finish, and a browser that goes away mid-scan.
 *
 * Needs Playwright's Chromium (`npx playwright install chromium`); no Redis.
 * Run alone with:
 *   npx jest --config ./test/jest-e2e.json test/scan-pipeline-robustness.e2e-spec.ts
 */
import { join } from 'node:path';
import { ServerResponse } from 'node:http';
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
import {
  ScanInterruptedError,
  ScanProcessor,
} from '../src/services/scan.processor';
import { BasicAuthCryptoService } from '../src/services/basic-auth-crypto.service';
import { scanConfig } from '../src/config/configuration';
import { UrlPolicyService } from '../src/services/url-policy.service';
import type { AgentAuditService } from '../src/agent/agent-audit.service';
import {
  FixtureSiteServer,
  startFixtureSiteServer,
} from './helpers/fixture-site-server';

/** Page deadline used here instead of the production two minutes. */
const TEST_PAGE_DEADLINE_MS = 3000;

/** An HTML page with an axe violation (image without alt) and `extra` markup. */
function page(title: string, extra = '') {
  return (_req: unknown, response: ServerResponse) => {
    response.statusCode = 200;
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(
      `<!doctype html><html lang="en"><head><title>${title}</title></head>` +
        `<body><main><h1>${title}</h1><img src="/pixel.png">${extra}</main></body></html>`,
    );
  };
}

describe('Scan pipeline robustness (real browser)', () => {
  jest.setTimeout(60000);

  let site: FixtureSiteServer;
  let dataSource: DataSource;
  let scanRepository: Repository<Scan>;
  let issueRepository: Repository<Issue>;
  let browserService: BrowserService;

  const siteUrl = (path: string): string => `${site.baseUrl}${path}`;

  function buildProcessor(): ScanProcessor {
    const config = {
      ...scanConfig(),
      allowPrivateTargets: true,
      // One page at a time, so a busy page cannot starve the others of a
      // renderer and every timing below is attributable.
      crawlConcurrency: 1,
    };
    const urlPolicy = new UrlPolicyService(config);
    const agentAudit = {
      resolveSkills: () => [],
      reset: () => Promise.resolve(undefined),
      collectForPage: () => Promise.resolve([]),
      evaluate: () => Promise.resolve(undefined),
    };
    const processor = new ScanProcessor(
      scanRepository,
      issueRepository,
      browserService,
      new AxeAccessibilityScanner(config, urlPolicy),
      new BasicAuthCryptoService(),
      config,
      urlPolicy,
      agentAudit as unknown as AgentAuditService,
    );
    Object.assign(processor, { pageDeadlineMs: TEST_PAGE_DEADLINE_MS });
    return processor;
  }

  /** First of three BullMQ attempts. */
  const jobFor = (scanId: number) =>
    ({ data: { scanId }, attemptsMade: 0, opts: { attempts: 3 } }) as Job;

  async function createPendingScan(overrides: Partial<Scan>): Promise<Scan> {
    return scanRepository.save(
      scanRepository.create({
        mode: ScanMode.SINGLE_URL,
        targets: [siteUrl('/index.html')],
        status: ScanStatus.PENDING,
        ...overrides,
      }),
    );
  }

  async function runScan(overrides: Partial<Scan>): Promise<Scan> {
    const scan = await createPendingScan(overrides);
    await buildProcessor().process(jobFor(scan.id));
    const finished = await scanRepository.findOne({
      where: { id: scan.id },
      relations: { issues: true },
    });
    if (!finished) throw new Error(`Scan ${scan.id} vanished`);
    return finished;
  }

  beforeAll(async () => {
    site = await startFixtureSiteServer(join(__dirname, 'fixtures', 'site'), {
      routes: {
        // DOMContentLoaded fires, then the main thread never yields again:
        // navigation succeeds, every later page.evaluate (axe) hangs.
        '/busy': page(
          'Busy page',
          '<script>document.addEventListener("DOMContentLoaded", () =>' +
            ' setTimeout(() => { for (;;) {} }, 0));</script>',
        ),
        '/fine': page('Fine page'),
        // Answers after two seconds, keeping the navigation in flight.
        '/slow': (req, res) => {
          setTimeout(() => page('Slow page')(req, res), 2000);
        },
        '/crawl-start': page(
          'Crawl start',
          '<nav><a href="/busy">Busy</a> <a href="/fine">Fine</a></nav>',
        ),
      },
    });
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
  });

  afterAll(async () => {
    await browserService.onApplicationShutdown('test teardown');
    await dataSource.destroy();
    await site.close();
  });

  beforeEach(async () => {
    await issueRepository.clear();
    await scanRepository.clear();
    site.requests.length = 0;
  });

  it('fails a page that stays busy after DOMContentLoaded and scans the next one', async () => {
    const startedAt = Date.now();

    const scan = await runScan({
      mode: ScanMode.URL_LIST,
      targets: [siteUrl('/busy'), siteUrl('/fine')],
    });

    expect(scan.status).toBe(ScanStatus.COMPLETED);
    expect(scan.pagesScanned).toBe(1);
    expect(scan.pagesFailed).toBe(1);
    expect(new Set(scan.issues.map((issue) => issue.pageUrl))).toEqual(
      new Set([siteUrl('/fine')]),
    );
    // The busy page was given up at its deadline, not at a browser timeout.
    expect(Date.now() - startedAt).toBeLessThan(TEST_PAGE_DEADLINE_MS + 10000);
  });

  describe('browser lost mid-scan', () => {
    it.each([
      [ScanMode.SINGLE_URL, {}],
      [
        ScanMode.CRAWL,
        { crawlMaxPages: 5, crawlStrategy: CrawlStrategy.SameHostname },
      ],
    ])(
      'fails a %s attempt retryably instead of completing it',
      async (mode, crawlOptions) => {
        const scan = await createPendingScan({
          mode,
          targets: [siteUrl('/slow')],
          ...crawlOptions,
        });
        const outcome = buildProcessor()
          .process(jobFor(scan.id))
          .then(
            () => 'completed',
            (error: unknown) => error,
          );
        // Wait until the navigation is in flight, then lose the browser (a
        // crash, a restart of the remote Playwright server, or a shutdown
        // closing it under the worker).
        while (!site.requests.some((request) => request.url === '/slow')) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await (await browserService.getBrowser()).close();

        expect(await outcome).toBeInstanceOf(ScanInterruptedError);
        const row = await scanRepository.findOneByOrFail({ id: scan.id });
        expect(row.status).toBe(ScanStatus.PENDING);
        expect(await issueRepository.count()).toBe(0);
      },
    );

    it('scans with a new browser afterwards', async () => {
      const scan = await runScan({ targets: [siteUrl('/fine')] });

      expect(scan.status).toBe(ScanStatus.COMPLETED);
      expect(scan.pagesScanned).toBe(1);
    });
  });

  it('fails a busy page in a crawl and keeps crawling', async () => {
    const scan = await runScan({
      mode: ScanMode.CRAWL,
      targets: [siteUrl('/crawl-start')],
      crawlMaxPages: 10,
      crawlMaxDepth: 1,
      crawlStrategy: CrawlStrategy.SameHostname,
    });

    expect(scan.status).toBe(ScanStatus.COMPLETED);
    expect(scan.pagesDiscovered).toBe(3);
    expect(scan.pagesScanned).toBe(2);
    expect(scan.pagesFailed).toBe(1);
    expect(new Set(scan.issues.map((issue) => issue.pageUrl))).toEqual(
      new Set([siteUrl('/crawl-start'), siteUrl('/fine')]),
    );
  });
});
