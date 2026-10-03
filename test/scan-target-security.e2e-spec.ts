/**
 * Real-browser coverage for scan-target security: what the scanner analyses,
 * stores and follows when a navigation fails, leaves the allowed targets, or
 * leaves the crawl scope.
 *
 * Needs Playwright's Chromium (`npx playwright install chromium`); no Redis.
 * Run alone with:
 *   npx jest --config ./test/jest-e2e.json test/scan-target-security.e2e-spec.ts
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

/** An HTML page with an axe violation (image without alt) and a marker title. */
function violatingPage(
  response: ServerResponse,
  status: number,
  title: string,
) {
  response.statusCode = status;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(
    `<!doctype html><html lang="en"><head><title>${title}</title></head>` +
      `<body><h1>${title}</h1><img src="/pixel.png"></body></html>`,
  );
}

describe('Scan target security (real browser)', () => {
  jest.setTimeout(120000);

  const fixtureRoot = join(__dirname, 'fixtures', 'site');
  let site: FixtureSiteServer;
  let dataSource: DataSource;
  let scanRepository: Repository<Scan>;
  let issueRepository: Repository<Issue>;
  let browserService: BrowserService;
  let agentAudit: {
    resolveSkills: jest.Mock;
    reset: jest.Mock;
    collectForPage: jest.Mock;
    remainingScanUnits: jest.Mock;
    evaluate: jest.Mock;
  };

  const siteUrl = (path: string): string => `${site.baseUrl}${path}`;

  /** Builds a processor whose policy and browser guard share one config. */
  function buildProcessor(
    overrides: Partial<ReturnType<typeof scanConfig>> = {},
  ): { processor: ScanProcessor; scanner: AxeAccessibilityScanner } {
    const config = { ...scanConfig(), ...overrides };
    const urlPolicy = new UrlPolicyService(config);
    const scanner = new AxeAccessibilityScanner(config, urlPolicy);
    const processor = new ScanProcessor(
      scanRepository,
      issueRepository,
      browserService,
      scanner,
      new BasicAuthCryptoService(),
      config,
      urlPolicy,
      agentAudit as unknown as AgentAuditService,
    );
    return { processor, scanner };
  }

  async function createPendingScan(overrides: Partial<Scan>): Promise<Scan> {
    return scanRepository.save(
      scanRepository.create({
        mode: ScanMode.SINGLE_URL,
        targets: [siteUrl('/index.html')],
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
      }),
    );
  }

  async function runScan(
    processor: ScanProcessor,
    overrides: Partial<Scan>,
  ): Promise<Scan> {
    const scan = await createPendingScan(overrides);
    await processor.process({ data: { scanId: scan.id } } as Job);
    const completed = await scanRepository.findOne({
      where: { id: scan.id },
      relations: { issues: true },
    });
    if (!completed) throw new Error(`Scan ${scan.id} vanished`);
    return completed;
  }

  beforeAll(async () => {
    site = await startFixtureSiteServer(fixtureRoot, {
      routes: {
        '/not-found': (_req, res) => violatingPage(res, 404, 'Missing page'),
        '/server-error': (_req, res) => violatingPage(res, 500, 'Broken page'),
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
    // A requested AI audit makes evidence collection observable: it must
    // never see a page whose content is rejected.
    agentAudit = {
      resolveSkills: jest.fn().mockReturnValue([{ id: 'page_title' }]),
      reset: jest.fn().mockResolvedValue(undefined),
      collectForPage: jest.fn().mockResolvedValue([]),
      remainingScanUnits: jest.fn().mockReturnValue(100),
      evaluate: jest.fn().mockResolvedValue(undefined),
    };
  });

  describe('HTTP error pages', () => {
    it('counts 4xx/5xx navigations as failed and stores none of their content', async () => {
      const { processor } = buildProcessor({ allowPrivateTargets: true });

      const scan = await runScan(processor, {
        mode: ScanMode.URL_LIST,
        targets: [
          siteUrl('/index.html'),
          siteUrl('/not-found'),
          siteUrl('/server-error'),
        ],
      });

      expect(scan.status).toBe(ScanStatus.COMPLETED);
      expect(scan.pagesDiscovered).toBe(3);
      expect(scan.pagesScanned).toBe(1);
      expect(scan.pagesFailed).toBe(2);
      const issuePages = new Set(scan.issues.map((issue) => issue.pageUrl));
      expect([...issuePages]).toEqual([siteUrl('/index.html')]);
      expect(agentAudit.collectForPage).toHaveBeenCalledTimes(1);
    });
  });
});
