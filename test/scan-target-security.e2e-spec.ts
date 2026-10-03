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
import {
  AxeAccessibilityScanner,
  TargetPolicyViolationError,
} from '../src/services/axe-accessibility-scanner.service';
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

/** Answers with a redirect to the given absolute URL. */
function redirectTo(location: () => string) {
  return (_req: unknown, response: ServerResponse) => {
    response.statusCode = 302;
    response.setHeader('location', location());
    response.end();
  };
}

/** Answers with an accessible HTML page whose body is `body`. */
function htmlPage(title: string, body: string) {
  return (_req: unknown, response: ServerResponse) => {
    response.statusCode = 200;
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(
      `<!doctype html><html lang="en"><head><title>${title}</title></head>` +
        `<body><main><h1>${title}</h1>${body}</main></body></html>`,
    );
  };
}

describe('Scan target security (real browser)', () => {
  jest.setTimeout(120000);

  const fixtureRoot = join(__dirname, 'fixtures', 'site');
  let site: FixtureSiteServer;
  /**
   * Stands in for an internal service. It listens on loopback like the site,
   * but is addressed as `localhost`, which the policy blocks while the site's
   * `127.0.0.1` is on the host allowlist.
   */
  let internal: FixtureSiteServer;
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
  const internalUrl = (path: string): string =>
    `http://localhost:${internal.port}${path}`;
  /** Policy of a deployment that only allowlists the site's host. */
  const guarded = {
    allowPrivateTargets: false,
    targetAllowHosts: ['127.0.0.1'],
  };

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
    internal = await startFixtureSiteServer(fixtureRoot, {
      routes: {
        '/secret': (_req, res) => violatingPage(res, 200, 'Internal secret'),
        '/frame': (_req, res) => violatingPage(res, 200, 'Internal frame'),
        '/evil.js': (_req, res) => {
          res.setHeader('content-type', 'application/javascript');
          res.end("document.title = 'Internal script ran';");
        },
      },
    });
    site = await startFixtureSiteServer(fixtureRoot, {
      routes: {
        '/not-found': (_req, res) => violatingPage(res, 404, 'Missing page'),
        '/server-error': (_req, res) => violatingPage(res, 500, 'Broken page'),
        '/to-internal': redirectTo(() => internalUrl('/secret')),
        '/r/frame': redirectTo(() => internalUrl('/frame')),
        '/r/script': redirectTo(() => internalUrl('/evil.js')),
        // Holds back DOMContentLoaded so an iframe's redirect resolves first.
        '/slow.js': (_req, res) => {
          setTimeout(() => {
            res.setHeader('content-type', 'application/javascript');
            res.end('void 0;');
          }, 300);
        },
        '/frame-to-internal': htmlPage(
          'Embeds a redirecting frame',
          '<iframe title="Widget" src="/r/frame"></iframe><script src="/slow.js"></script>',
        ),
        '/script-to-internal': htmlPage(
          'Loads a redirecting script',
          '<script src="/r/script"></script>',
        ),
        '/direct-internal-image': htmlPage(
          'References an internal image',
          `<img alt="Logo" src="${internalUrl('/direct.png')}">`,
        ),
        '/websocket-to-internal': htmlPage(
          'Opens an internal WebSocket',
          `<script>
            window.socketOutcome = new Promise((resolve) => {
              const socket = new WebSocket('ws://localhost:${internal.port}/live');
              socket.onopen = () => resolve('open');
              socket.onclose = (event) => resolve('closed ' + event.code);
            });
          </script>`,
        ),
        '/sw.js': (_req, res) => {
          res.setHeader('content-type', 'application/javascript');
          res.end(
            "self.addEventListener('install', (event) => {" +
              ` event.waitUntil(fetch('${internalUrl('/from-service-worker')}').catch(() => {}));` +
              ' self.skipWaiting(); });',
          );
        },
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
    await internal.close();
  });

  beforeEach(async () => {
    await issueRepository.clear();
    await scanRepository.clear();
    site.requests.length = 0;
    internal.requests.length = 0;
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

  describe('target policy in the browser', () => {
    it('fails a page that redirects to a blocked address and keeps nothing from it', async () => {
      const { processor } = buildProcessor(guarded);

      const scan = await runScan(processor, {
        mode: ScanMode.SINGLE_URL,
        targets: [siteUrl('/to-internal')],
      });

      expect(scan.status).toBe(ScanStatus.COMPLETED);
      expect(scan.pagesScanned).toBe(0);
      expect(scan.pagesFailed).toBe(1);
      expect(scan.issues).toEqual([]);
      expect(agentAudit.collectForPage).not.toHaveBeenCalled();
    });

    it('names the blocked redirect target and closes the page', async () => {
      const { scanner } = buildProcessor(guarded);
      const context = await scanner.createContext(
        await browserService.getBrowser(),
      );
      try {
        const page = await context.newPage();

        await expect(
          scanner.scanPage(page, siteUrl('/to-internal')),
        ).rejects.toThrow(TargetPolicyViolationError);
        await expect(scanner.assertPageAllowed(page)).rejects.toThrow(
          internalUrl('/secret'),
        );
        expect(page.isClosed()).toBe(true);
      } finally {
        await context.close();
      }
    });

    it('fails pages whose iframe or script follows a redirect to a blocked address', async () => {
      const { processor } = buildProcessor(guarded);

      const scan = await runScan(processor, {
        mode: ScanMode.URL_LIST,
        targets: [
          siteUrl('/frame-to-internal'),
          siteUrl('/script-to-internal'),
          siteUrl('/index.html'),
        ],
      });

      expect(scan.pagesScanned).toBe(1);
      expect(scan.pagesFailed).toBe(2);
      const issuePages = new Set(scan.issues.map((issue) => issue.pageUrl));
      expect([...issuePages]).toEqual([siteUrl('/index.html')]);
      expect(agentAudit.collectForPage).toHaveBeenCalledTimes(1);
    });

    it('still scans a page whose direct request to a blocked address is aborted unsent', async () => {
      const { processor } = buildProcessor(guarded);

      const scan = await runScan(processor, {
        mode: ScanMode.SINGLE_URL,
        targets: [siteUrl('/direct-internal-image')],
      });

      expect(scan.pagesScanned).toBe(1);
      expect(scan.pagesFailed).toBe(0);
      expect(internal.requests).toEqual([]);
    });

    it('refuses a WebSocket to a blocked address before it connects', async () => {
      const { scanner } = buildProcessor(guarded);
      const context = await scanner.createContext(
        await browserService.getBrowser(),
      );
      try {
        const page = await context.newPage();
        await scanner.scanPage(page, siteUrl('/websocket-to-internal'));

        const outcome = await page.evaluate(
          () =>
            (window as unknown as { socketOutcome: Promise<string> })
              .socketOutcome,
        );
        expect(outcome).toBe('closed 1008');
        expect(internal.requests).toEqual([]);
      } finally {
        await context.close();
      }
    });

    it('routes service-worker requests, even when registered past the page API', async () => {
      const { scanner } = buildProcessor(guarded);
      const context = await scanner.createContext(
        await browserService.getBrowser(),
      );
      try {
        const page = await context.newPage();
        await page.goto(siteUrl('/index.html'));

        const registered = await page.evaluate(async () => {
          const container = navigator.serviceWorker;
          const registration =
            await ServiceWorkerContainer.prototype.register.call(
              container,
              '/sw.js',
            );
          const worker = registration.installing ?? registration.active;
          await new Promise<void>((resolve) => {
            if (!worker || worker.state === 'activated') return resolve();
            worker.addEventListener('statechange', () => {
              if (worker.state === 'activated') resolve();
            });
          });
          return true;
        });

        expect(registered).toBe(true);
        expect(internal.requests).toEqual([]);
      } finally {
        await context.close();
      }
    });

    it('removes SharedWorker, whose requests Playwright cannot route', async () => {
      const { scanner } = buildProcessor(guarded);
      const context = await scanner.createContext(
        await browserService.getBrowser(),
      );
      try {
        const page = await context.newPage();
        await page.goto(siteUrl('/index.html'));

        const available = await page.evaluate(() => {
          const frame = document.createElement('iframe');
          document.body.append(frame);
          const frameWindow = frame.contentWindow as unknown as {
            SharedWorker?: unknown;
          };
          return [typeof SharedWorker, typeof frameWindow.SharedWorker];
        });

        expect(available).toEqual(['undefined', 'undefined']);
      } finally {
        await context.close();
      }
    });
  });
});
