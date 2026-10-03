const mockAxeBuilder = {
  include: jest.fn().mockReturnThis(),
  withRules: jest.fn().mockReturnThis(),
  analyze: jest.fn().mockResolvedValue({ violations: [] }),
};
const mockAxeBuilderCtor = jest.fn(() => mockAxeBuilder);

jest.mock('@axe-core/playwright', () => ({
  __esModule: true,
  default: function AxeBuilder(...args: unknown[]) {
    return (mockAxeBuilderCtor as (...a: unknown[]) => unknown)(...args);
  },
}));

import {
  AxeAccessibilityScanner,
  PageNavigationError,
  TargetPolicyViolationError,
} from './axe-accessibility-scanner.service';
import type { UrlPolicyService } from './url-policy.service';

/** Minimal Playwright Route stub capturing continue/abort outcomes. */
function makeRoute(url: string) {
  return {
    request: () => ({ url: () => url }),
    continue: jest.fn().mockResolvedValue(undefined),
    abort: jest.fn().mockResolvedValue(undefined),
  };
}

/** Policy stub: IP-literal private hosts and *.internal are blocked. */
function policyDecision(url: string) {
  const host = new URL(url).hostname;
  return /^(10\.|127\.|169\.254\.)/.test(host) || host.endsWith('.internal')
    ? { allowed: false, reason: `${host} is in a private or reserved range` }
    : { allowed: true };
}

/** Browser-context stub recording the guard's route, WS route and listener. */
function makeContext() {
  const pages: any[] = [];
  const context = {
    pages: () => pages,
    addInitScript: jest.fn().mockResolvedValue(undefined),
    route: jest.fn((_pattern: string, handler: any) => {
      context.routeHandler = handler;
      return Promise.resolve();
    }),
    routeWebSocket: jest.fn((_pattern: unknown, handler: any) => {
      context.webSocketHandler = handler;
      return Promise.resolve();
    }),
    on: jest.fn((event: string, listener: any) => {
      if (event === 'request') context.requestListener = listener;
      return context;
    }),
    newPage: () => {
      const page = {
        context: () => context,
        url: jest.fn().mockReturnValue('https://example.com/'),
        goto: jest.fn().mockResolvedValue({ status: () => 200 }),
        close: jest.fn().mockResolvedValue(undefined),
      };
      pages.push(page);
      return page;
    },
    routeHandler: undefined as
      | ((route: ReturnType<typeof makeRoute>) => Promise<void>)
      | undefined,
    webSocketHandler: undefined as ((ws: any) => Promise<void>) | undefined,
    requestListener: undefined as ((request: any) => void) | undefined,
  };
  return context;
}

/** Request stub as emitted by context.on('request'). */
function makeRequest(url: string, page: unknown, redirectedFrom?: string) {
  return {
    url: () => url,
    redirectedFrom: () =>
      redirectedFrom ? { url: () => redirectedFrom } : null,
    frame: () => ({ page: () => page }),
  };
}

/** Lets queued policy checks (promise callbacks) run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('AxeAccessibilityScanner target-policy guard', () => {
  let context: ReturnType<typeof makeContext>;
  let browser: { newContext: jest.Mock };
  let urlPolicy: { isAllowedTarget: jest.Mock };

  const build = (allowPrivateTargets: boolean) => {
    const config = { ignoreHttpsErrors: false, allowPrivateTargets } as any;
    return new AxeAccessibilityScanner(
      config,
      urlPolicy as unknown as UrlPolicyService,
    );
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAxeBuilder.analyze.mockResolvedValue({ violations: [] });
    context = makeContext();
    browser = { newContext: jest.fn().mockResolvedValue(context) };
    urlPolicy = {
      isAllowedTarget: jest.fn((url: string) =>
        Promise.resolve(policyDecision(url)),
      ),
    };
  });

  it('keeps service workers enabled so their requests stay routed', async () => {
    // With serviceWorkers: 'block', Playwright 1.60 stops intercepting
    // service-worker traffic while a page can still register one through
    // ServiceWorkerContainer.prototype.register — an unguarded channel.
    await build(false).createContext(browser as any);
    expect(browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ serviceWorkers: 'allow' }),
    );
  });

  it('removes page APIs whose connections Playwright never routes', async () => {
    await build(false).createContext(browser as any);
    expect(context.addInitScript).toHaveBeenCalledTimes(1);

    const names = [
      'SharedWorker',
      'WebSocketStream',
      'WebTransport',
      'RTCPeerConnection',
      'webkitRTCPeerConnection',
    ];
    const [script] = context.addInitScript.mock.calls[0] as [() => void];
    const scope = globalThis as Record<string, unknown>;
    for (const name of names) scope[name] = class {};
    script();
    expect(names.filter((name) => name in scope)).toEqual([]);
  });

  it('scopes Basic Auth credentials to their origin', async () => {
    await build(true).createContext(browser as any, {
      basicAuth: {
        username: 'scanner',
        password: 'secret',
        origin: 'https://staging.example.com',
      },
    });

    expect(browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({
        httpCredentials: {
          username: 'scanner',
          password: 'secret',
          origin: 'https://staging.example.com',
        },
      }),
    );
  });

  it('does not intercept requests when private targets are allowed', async () => {
    const scanner = build(true);
    await scanner.createContext(browser as any);
    expect(context.route).not.toHaveBeenCalled();
    expect(context.routeWebSocket).not.toHaveBeenCalled();
    expect(context.on).not.toHaveBeenCalled();
    expect(context.addInitScript).not.toHaveBeenCalled();
  });

  it('installs a wildcard route when private targets are blocked', async () => {
    const scanner = build(false);
    await scanner.createContext(browser as any);
    expect(context.route).toHaveBeenCalledWith('**/*', expect.any(Function));
  });

  it('continues allowed HTTP(S) requests and aborts blocked ones', async () => {
    const scanner = build(false);
    await scanner.createContext(browser as any);

    const allowed = makeRoute('https://example.com/app.js');
    await context.routeHandler!(allowed);
    expect(allowed.continue).toHaveBeenCalled();
    expect(allowed.abort).not.toHaveBeenCalled();

    const blocked = makeRoute('http://169.254.169.254/latest/meta-data/');
    await context.routeHandler!(blocked);
    expect(blocked.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(blocked.continue).not.toHaveBeenCalled();
  });

  it('lets non-HTTP schemes through without a policy lookup', async () => {
    const scanner = build(false);
    await scanner.createContext(browser as any);

    const dataUri = makeRoute('data:image/png;base64,AAAA');
    await context.routeHandler!(dataUri);
    expect(dataUri.continue).toHaveBeenCalled();
    expect(urlPolicy.isAllowedTarget).not.toHaveBeenCalled();
  });

  it('aborts requests whose URL cannot be parsed', async () => {
    const scanner = build(false);
    await scanner.createContext(browser as any);

    const bad = makeRoute('not a url');
    await context.routeHandler!(bad);
    expect(bad.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(urlPolicy.isAllowedTarget).not.toHaveBeenCalled();
  });

  it('caches the policy decision per host', async () => {
    const scanner = build(false);
    await scanner.createContext(browser as any);

    await context.routeHandler!(makeRoute('https://example.com/a.css'));
    await context.routeHandler!(makeRoute('https://example.com/b.js'));
    await context.routeHandler!(makeRoute('https://example.com/c.png'));

    // Same host → resolved once, then served from the per-context cache.
    expect(urlPolicy.isAllowedTarget).toHaveBeenCalledTimes(1);
  });

  describe('redirect hops (never routed by Playwright)', () => {
    it('rejects and closes a page whose request was redirected to a blocked target', async () => {
      const scanner = build(false);
      await scanner.createContext(browser as any);
      const page = context.newPage();

      context.requestListener!(
        makeRequest(
          'http://169.254.169.254/latest/meta-data/',
          page,
          'https://example.com/redirect',
        ),
      );

      await expect(scanner.assertPageAllowed(page)).rejects.toThrow(
        TargetPolicyViolationError,
      );
      await expect(scanner.assertPageAllowed(page)).rejects.toThrow(
        '169.254.169.254',
      );
      expect(page.close).toHaveBeenCalled();
    });

    it('accepts pages whose redirect hops stay on allowed targets', async () => {
      const scanner = build(false);
      await scanner.createContext(browser as any);
      const page = context.newPage();

      context.requestListener!(
        makeRequest('https://www.example.com/', page, 'https://example.com/'),
      );

      await expect(scanner.assertPageAllowed(page)).resolves.toBeUndefined();
      expect(page.close).not.toHaveBeenCalled();
    });

    it('leaves first-hop requests to the route handler, which already aborted them', async () => {
      const scanner = build(false);
      await scanner.createContext(browser as any);
      const page = context.newPage();

      // e.g. <img src="http://10.0.0.5/x.png"> on a public page: the route
      // aborts it before it is sent, so the page itself stays scannable.
      context.requestListener!(makeRequest('http://10.0.0.5/x.png', page));
      await flush();

      await expect(scanner.assertPageAllowed(page)).resolves.toBeUndefined();
      expect(page.close).not.toHaveBeenCalled();
    });

    it('rejects every open page when a hop cannot be attributed to one', async () => {
      const scanner = build(false);
      await scanner.createContext(browser as any);
      const first = context.newPage();
      const second = context.newPage();
      const orphan = {
        ...makeRequest('http://10.0.0.5/', null, 'https://example.com/r'),
        frame: () => {
          throw new Error('Service Worker requests do not have a frame');
        },
      };

      context.requestListener!(orphan);

      await expect(scanner.assertPageAllowed(first)).rejects.toThrow(
        TargetPolicyViolationError,
      );
      await expect(scanner.assertPageAllowed(second)).rejects.toThrow(
        TargetPolicyViolationError,
      );
    });
  });

  describe('final URL', () => {
    it('rejects a page that ended on a blocked target before analysing it', async () => {
      const scanner = build(false);
      await scanner.createContext(browser as any);
      const page = context.newPage();
      page.url.mockReturnValue('http://169.254.169.254/latest/meta-data/');

      await expect(
        scanner.scanPage(page, 'https://example.com/'),
      ).rejects.toThrow(TargetPolicyViolationError);
      expect(mockAxeBuilderCtor).not.toHaveBeenCalled();
    });

    it('reports the violation when the guard closed the page mid-navigation', async () => {
      const scanner = build(false);
      await scanner.createContext(browser as any);
      const page = context.newPage();
      page.goto.mockImplementation(() => {
        context.requestListener!(
          makeRequest('http://10.0.0.5/', page, 'https://example.com/r'),
        );
        return Promise.reject(new Error('Target page has been closed'));
      });

      await expect(
        scanner.scanPage(page, 'https://example.com/r'),
      ).rejects.toThrow(TargetPolicyViolationError);
    });

    it('discards axe results when a blocked hop happened during analysis', async () => {
      const scanner = build(false);
      await scanner.createContext(browser as any);
      const page = context.newPage();
      mockAxeBuilder.analyze.mockImplementation(() => {
        context.requestListener!(
          makeRequest('http://10.0.0.5/img.png', page, 'https://cdn.example/i'),
        );
        return Promise.resolve({ violations: [] });
      });

      await expect(
        scanner.scanPage(page, 'https://example.com/'),
      ).rejects.toThrow(TargetPolicyViolationError);
    });

    it('skips all policy checks when private targets are allowed', async () => {
      const scanner = build(true);
      await scanner.createContext(browser as any);
      const page = context.newPage();
      page.url.mockReturnValue('http://169.254.169.254/');

      await expect(
        scanner.scanPage(page, 'http://169.254.169.254/'),
      ).resolves.toEqual({ finalUrl: 'http://169.254.169.254/', issues: [] });
      expect(urlPolicy.isAllowedTarget).not.toHaveBeenCalled();
    });
  });

  describe('WebSockets', () => {
    const makeWebSocket = (url: string) => ({
      url: () => url,
      connectToServer: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    });

    it('routes every WebSocket through the policy', async () => {
      await build(false).createContext(browser as any);
      expect(context.routeWebSocket).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Function),
      );
    });

    it('connects allowed WebSockets to their server', async () => {
      await build(false).createContext(browser as any);
      const ws = makeWebSocket('wss://example.com/live');

      await context.webSocketHandler!(ws);

      expect(ws.connectToServer).toHaveBeenCalled();
      expect(ws.close).not.toHaveBeenCalled();
    });

    it('refuses WebSockets to blocked targets without connecting', async () => {
      await build(false).createContext(browser as any);
      const ws = makeWebSocket('ws://10.0.0.5:6379/');

      await context.webSocketHandler!(ws);

      expect(ws.connectToServer).not.toHaveBeenCalled();
      expect(ws.close).toHaveBeenCalledWith(
        expect.objectContaining({ code: 1008 }),
      );
    });
  });
});

describe('AxeAccessibilityScanner navigation outcome', () => {
  let scanner: AxeAccessibilityScanner;

  /** Page stub whose goto() resolves with the given navigation response. */
  const makePage = (
    response: { status: () => number } | null,
    finalUrl = 'https://example.com/',
  ) => ({
    goto: jest.fn().mockResolvedValue(response),
    url: jest.fn().mockReturnValue(finalUrl),
    context: jest.fn().mockReturnValue({}),
  });
  const respond = (status: number) => ({ status: () => status });

  beforeEach(() => {
    jest.clearAllMocks();
    mockAxeBuilder.analyze.mockResolvedValue({ violations: [] });
    scanner = new AxeAccessibilityScanner(
      { ignoreHttpsErrors: false, allowPrivateTargets: true } as any,
      { isAllowedTarget: jest.fn() } as unknown as UrlPolicyService,
    );
  });

  it.each([401, 403, 404, 410, 500, 503])(
    'rejects a navigation ending with HTTP %i without analysing the error page',
    async (status) => {
      const page = makePage(respond(status));

      const scan = scanner.scanPage(page as any, 'https://example.com/');

      await expect(scan).rejects.toThrow(PageNavigationError);
      await expect(scan).rejects.toThrow(`HTTP ${status}`);
      expect(mockAxeBuilderCtor).not.toHaveBeenCalled();
    },
  );

  it('rejects a navigation that produced no response', async () => {
    const page = makePage(null);

    await expect(
      scanner.scanPage(page as any, 'https://example.com/'),
    ).rejects.toThrow(PageNavigationError);
    expect(mockAxeBuilderCtor).not.toHaveBeenCalled();
  });

  it('analyses a 2xx page and reports the post-redirect URL', async () => {
    const page = makePage(respond(200), 'https://www.example.com/');

    const result = await scanner.scanPage(page as any, 'https://example.com/');

    expect(page.goto).toHaveBeenCalledWith('https://example.com/', {
      waitUntil: 'domcontentloaded',
    });
    expect(mockAxeBuilder.analyze).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      finalUrl: 'https://www.example.com/',
      issues: [],
    });
  });
});
