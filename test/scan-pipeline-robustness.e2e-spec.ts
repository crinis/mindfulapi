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
import { agentConfig } from '../src/config/configuration';
import { AgentAuditService } from '../src/agent/agent-audit.service';
import type { AgentHarnessService } from '../src/agent/harness/agent-harness.service';
import { SkillRegistry } from '../src/agent/skills/skill-registry';
import { ImageAltTextSkill } from '../src/agent/skills/image-alt-text.skill';
import { HeadingStructureSkill } from '../src/agent/skills/heading-structure.skill';
import { LinkPurposeSkill } from '../src/agent/skills/link-purpose.skill';
import { FormLabelsSkill } from '../src/agent/skills/form-labels.skill';
import { PageTitleSkill } from '../src/agent/skills/page-title.skill';
import { AgentSkill } from '../src/enums/agent-skill.enum';
import {
  FixtureSiteServer,
  startFixtureSiteServer,
} from './helpers/fixture-site-server';

/** SCAN_PAGE_TIMEOUT_MS used here instead of the default two minutes. */
const TEST_PAGE_DEADLINE_MS = 3000;
/** Part of it kept free of AI evidence collection (production: 15 s). */
const TEST_EVIDENCE_RESERVE_MS = 500;

/** A 1x1 PNG, rendered at whatever size the markup asks for. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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

  /**
   * The real AI-audit collection with the image skill. Its harness has no
   * model: an evaluation would fail its units, never reach a provider.
   */
  function realAgentAudit(): AgentAuditService {
    const settings = {
      ...agentConfig(),
      enabled: true,
      allowedSkills: [AgentSkill.IMAGE_ALT_TEXT],
      allowedScanModes: [ScanMode.SINGLE_URL],
    };
    const harness = {
      evaluateStructured: () =>
        Promise.reject(new Error('No model in this test')),
    } as unknown as AgentHarnessService;
    return new AgentAuditService(
      dataSource.getRepository(AgentFinding),
      scanRepository,
      new SkillRegistry(
        new ImageAltTextSkill(),
        new HeadingStructureSkill(),
        new LinkPurposeSkill(),
        new FormLabelsSkill(),
        new PageTitleSkill(),
      ),
      harness,
      settings,
    );
  }

  function buildProcessor(
    agentAudit: Pick<
      AgentAuditService,
      'resolveSkills' | 'reset' | 'collectForPage' | 'evaluate'
    > = {
      resolveSkills: () => [],
      reset: () => Promise.resolve(undefined),
      collectForPage: () => Promise.resolve([]),
      evaluate: () => Promise.resolve(undefined),
    },
  ): ScanProcessor {
    const config = {
      ...scanConfig(),
      allowPrivateTargets: true,
      // One page at a time, so a busy page cannot starve the others of a
      // renderer and every timing below is attributable.
      crawlConcurrency: 1,
      pageTimeoutMs: TEST_PAGE_DEADLINE_MS,
    };
    const urlPolicy = new UrlPolicyService(config);
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
    Object.assign(processor, { evidenceReserveMs: TEST_EVIDENCE_RESERVE_MS });
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

  async function runScan(
    overrides: Partial<Scan>,
    processor: ScanProcessor = buildProcessor(),
  ): Promise<Scan> {
    const scan = await createPendingScan(overrides);
    await processor.process(jobFor(scan.id));
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
        // Images that script keeps moving: a screenshot waits for each to
        // stand still until its timeout (5 s), longer than the page deadline.
        '/moving-images': page(
          'Moving images',
          Array.from(
            { length: 5 },
            (_, i) =>
              `<img class="moving" alt="Product ${i}" width="80" height="80" src="${PNG}">`,
          ).join('') +
            '<script>let x = 0; setInterval(() => { x = (x + 1) % 40;' +
            ' document.querySelectorAll(".moving").forEach((img) =>' +
            ' { img.style.marginLeft = x + "px"; }); }, 16);</script>',
        ),
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

  it('keeps the axe issues of a page whose AI evidence runs out of time', async () => {
    const scan = await runScan(
      {
        targets: [siteUrl('/moving-images')],
        aiAuditSkills: [AgentSkill.IMAGE_ALT_TEXT],
      },
      buildProcessor(realAgentAudit()),
    );

    expect(scan.status).toBe(ScanStatus.COMPLETED);
    expect(scan.pagesScanned).toBe(1);
    expect(scan.pagesFailed).toBe(0);
    expect(scan.issues.map((issue) => issue.ruleId)).toContain('image-alt');
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
