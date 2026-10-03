/**
 * Real-browser coverage for scan-pipeline robustness: pages that never let the
 * analysis finish.
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
import { ScanProcessor } from '../src/services/scan.processor';
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

  async function runScan(overrides: Partial<Scan>): Promise<Scan> {
    const scan = await scanRepository.save(
      scanRepository.create({
        mode: ScanMode.SINGLE_URL,
        targets: [siteUrl('/index.html')],
        status: ScanStatus.PENDING,
        ...overrides,
      }),
    );
    await buildProcessor().process({ data: { scanId: scan.id } } as Job);
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
