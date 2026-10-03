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
import { installInertConnectionApis } from './inert-connection-apis';

/** Minimal Playwright Route stub capturing continue/abort outcomes. */
function makeRoute(url: string) {
  return {
    request: () => ({ url: () => url }),
    continue: jest.fn().mockResolvedValue(undefined),
    abort: jest.fn().mockResolvedValue(undefined),
  };
}

/**
 * Policy stub: IP-literal private hosts and *.internal are blocked as private
 * addresses, *.invalid names do not resolve, and lookups of *.flaky fail.
 */
function policyDecision(url: string) {
  const host = new URL(url).hostname;
  if (/^(10\.|127\.|169\.254\.)/.test(host) || host.endsWith('.internal')) {
    return {
      allowed: false,
      code: 'private_address',
      reason: `${host} is in a private or reserved range`,
    };
  }
  if (host.endsWith('.invalid')) {
    return {
      allowed: false,
      code: 'unresolvable',
      reason: `hostname ${host} could not be resolved`,
    };
  }
  if (host.endsWith('.flaky')) {
    return {
      allowed: false,
      code: 'lookup_failed',
      reason: `hostname ${host} could not be resolved (EAI_AGAIN)`,
    };
  }
  return { allowed: true };
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
        /** The page that opened this one (a popup), as page.opener() says. */
        openedBy: null as unknown,
        opener: jest.fn(() => Promise.resolve(page.openedBy)),
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

/**
 * Request stub as emitted by context.on('request'). `response` is what
 * request.response() resolves with: by default the browser got an answer.
 */
function makeRequest(
  url: string,
  page: unknown,
  redirectedFrom?: string,
  response: () => Promise<unknown> = () =>
    Promise.resolve({ status: () => 200 }),
  /** Chromium's net error once the request failed (request.failure()). */
  errorText?: string,
) {
  return {
    url: () => url,
    redirectedFrom: () =>
      redirectedFrom ? { url: () => redirectedFrom } : null,
    frame: () => ({ page: () => page }),
    serviceWorker: () => null,
    isNavigationRequest: () => false,
    response: jest.fn(response),
    failure: () => (errorText ? { errorText } : null),
  };
}

/** A request a service worker made: it has no frame. */
function makeWorkerRequest(
  url: string,
  workerUrl: string,
  redirectedFrom?: string,
) {
  return {
    ...makeRequest(url, null, redirectedFrom),
    frame: () => {
      throw new Error(
        'Service Worker requests do not have an associated frame.',
      );
    },
    serviceWorker: () => ({ url: () => workerUrl }),
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

  it('replaces page APIs whose connections Playwright never routes with inert ones', async () => {
    await build(false).createContext(browser as any);

    expect(context.addInitScript).toHaveBeenCalledTimes(1);
    expect(context.addInitScript).toHaveBeenCalledWith(
      installInertConnectionApis,
    );
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

  it('caches a name that does not exist like any definitive answer', async () => {
    await build(false).createContext(browser as any);

    await context.routeHandler!(makeRoute('http://gone.invalid/a.png'));
    await context.routeHandler!(makeRoute('http://gone.invalid/b.png'));

    expect(urlPolicy.isAllowedTarget).toHaveBeenCalledTimes(1);
  });

  it('does not keep a failed lookup for the rest of the scan', async () => {
    await build(false).createContext(browser as any);
    urlPolicy.isAllowedTarget
      .mockResolvedValueOnce(policyDecision('http://cdn.flaky/'))
      .mockResolvedValueOnce({ allowed: true });

    const first = makeRoute('http://cdn.flaky/a.js');
    await context.routeHandler!(first);
    const second = makeRoute('http://cdn.flaky/b.js');
    await context.routeHandler!(second);

    // The first request could not be vetted, so it was not sent; the next
    // one looked the host up again.
    expect(first.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(second.continue).toHaveBeenCalled();
    expect(urlPolicy.isAllowedTarget).toHaveBeenCalledTimes(2);
  });

  it('shares one lookup between requests made while it is in flight', async () => {
    await build(false).createContext(browser as any);
    let answer!: (result: unknown) => void;
    urlPolicy.isAllowedTarget.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );

    const first = context.routeHandler!(makeRoute('http://cdn.flaky/a.js'));
    const second = context.routeHandler!(makeRoute('http://cdn.flaky/b.js'));
    answer(policyDecision('http://cdn.flaky/'));
    await Promise.all([first, second]);

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

    it('flags a hop to a private address without waiting for its response', async () => {
      const scanner = build(false);
      await scanner.createContext(browser as any);
      const page = context.newPage();
      const request = makeRequest(
        'http://10.0.0.5/',
        page,
        'https://example.com/r',
        () => new Promise(() => undefined),
      );

      context.requestListener!(request);

      await expect(scanner.assertPageAllowed(page)).rejects.toThrow(
        TargetPolicyViolationError,
      );
      expect(request.response).not.toHaveBeenCalled();
    });

    describe('to a host the policy could not resolve', () => {
      it.each([
        ['http://gone.invalid/p.png', 'net::ERR_NAME_NOT_RESOLVED'],
        ['http://tracker.flaky/p.png', 'net::ERR_NAME_RESOLUTION_FAILED'],
        ['http://sinkhole.invalid/p.png', 'net::ERR_CONNECTION_REFUSED'],
        ['http://sinkhole.invalid/p.png', 'net::ERR_ADDRESS_INVALID'],
        ['http://far.invalid/p.png', 'net::ERR_ADDRESS_UNREACHABLE'],
        ['http://far.invalid/p.png', 'net::ERR_CONNECTION_TIMED_OUT'],
        ['http://odd.invalid:25/p.png', 'net::ERR_UNSAFE_PORT'],
      ])(
        'keeps the page when the browser could not reach %s either (%s)',
        async (url, errorText) => {
          const scanner = build(false);
          await scanner.createContext(browser as any);
          const page = context.newPage();
          const request = makeRequest(
            url,
            page,
            'https://cdn.example/r',
            () => Promise.resolve(null),
            errorText,
          );

          context.requestListener!(request);

          await expect(
            scanner.assertPageAllowed(page),
          ).resolves.toBeUndefined();
          expect(request.response).toHaveBeenCalled();
          expect(page.close).not.toHaveBeenCalled();
        },
      );

      it.each([
        ['CORS withheld the response', 'net::ERR_FAILED'],
        ['ORB withheld the response', 'net::ERR_BLOCKED_BY_ORB'],
        ['the server closed the connection', 'net::ERR_EMPTY_RESPONSE'],
        ['the failure is unknown', undefined],
      ])(
        'rejects the page when the request reached the host but %s',
        async (_label, errorText) => {
          const scanner = build(false);
          await scanner.createContext(browser as any);
          const page = context.newPage();

          context.requestListener!(
            makeRequest(
              'http://browser-only.invalid/data',
              page,
              'https://a/r',
              () => Promise.resolve(null),
              errorText,
            ),
          );

          await expect(scanner.assertPageAllowed(page)).rejects.toThrow(
            /browser-only\.invalid.*could not be resolved/,
          );
        },
      );

      it('rejects the page when the browser got a response from it', async () => {
        const scanner = build(false);
        await scanner.createContext(browser as any);
        const page = context.newPage();

        context.requestListener!(
          makeRequest('http://browser-only.invalid/p.png', page, 'https://a/r'),
        );

        await expect(scanner.assertPageAllowed(page)).rejects.toThrow(
          /browser-only\.invalid.*could not be resolved/,
        );
        expect(page.close).toHaveBeenCalled();
      });

      it('waits for the outcome before the page passes', async () => {
        const scanner = build(false);
        await scanner.createContext(browser as any);
        const page = context.newPage();
        let respond!: (response: unknown) => void;
        context.requestListener!(
          makeRequest(
            'http://late.invalid/p.png',
            page,
            'https://a/r',
            () =>
              new Promise((resolve) => {
                respond = resolve;
              }),
          ),
        );

        const check = scanner.assertPageAllowed(page);
        await flush();
        respond({ status: () => 200 });

        await expect(check).rejects.toThrow(TargetPolicyViolationError);
      });

      it('treats a response that ended with the page closing as no response', async () => {
        const scanner = build(false);
        await scanner.createContext(browser as any);
        const page = context.newPage();
        context.requestListener!(
          makeRequest('http://slow.invalid/p.png', page, 'https://a/r', () =>
            Promise.reject(new Error('Target page has been closed')),
          ),
        );

        await expect(scanner.assertPageAllowed(page)).resolves.toBeUndefined();
      });

      it('re-checks a failed lookup once the response arrived', async () => {
        const scanner = build(false);
        await scanner.createContext(browser as any);
        const page = context.newPage();
        // The first lookup failed transiently; the retry resolves publicly.
        urlPolicy.isAllowedTarget
          .mockResolvedValueOnce(policyDecision('http://cdn.flaky/'))
          .mockResolvedValueOnce({ allowed: true });

        context.requestListener!(
          makeRequest('http://cdn.flaky/p.png', page, 'https://a/r'),
        );

        await expect(scanner.assertPageAllowed(page)).resolves.toBeUndefined();
        const hopLookups = urlPolicy.isAllowedTarget.mock.calls.filter(
          ([url]) => (url as string).includes('cdn.flaky'),
        );
        expect(hopLookups).toHaveLength(2);
      });
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
        // e.g. the first navigation of a popup
        frame: () => {
          throw new Error('Frame for this navigation request is not available');
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

    describe('that cannot be attributed to one page', () => {
      it('rejects every open page for a blocked hop of a service worker', async () => {
        const scanner = build(false);
        await scanner.createContext(browser as any);
        const client = context.newPage();
        const other = context.newPage();

        context.requestListener!(
          makeWorkerRequest(
            'http://10.0.0.5/',
            'https://a.example/sw.js',
            'https://a.example/r',
          ),
        );

        // A worker can pass what it read to any page (through an allowed
        // host), and Playwright does not say which pages it controls.
        await expect(scanner.assertPageAllowed(client)).rejects.toThrow(
          TargetPolicyViolationError,
        );
        await expect(scanner.assertPageAllowed(other)).rejects.toThrow(
          TargetPolicyViolationError,
        );
      });

      it('also rejects a page opened while the check ran, which waits for it', async () => {
        const scanner = build(false);
        await scanner.createContext(browser as any);
        let answer!: (result: unknown) => void;
        urlPolicy.isAllowedTarget.mockReturnValueOnce(
          new Promise((resolve) => {
            answer = resolve;
          }),
        );
        context.requestListener!(
          makeWorkerRequest(
            'http://10.0.0.5/',
            'https://a.example/sw.js',
            'https://a.example/r',
          ),
        );
        const late = context.newPage();

        const check = scanner.assertPageAllowed(late);
        await flush();
        answer(policyDecision('http://10.0.0.5/'));

        await expect(check).rejects.toThrow(TargetPolicyViolationError);
      });

      it('lets every page pass when a service worker hop is allowed', async () => {
        const scanner = build(false);
        await scanner.createContext(browser as any);
        const page = context.newPage();

        context.requestListener!(
          makeWorkerRequest(
            'https://cdn.example/app.js',
            'https://a.example/sw.js',
            'https://a.example/r',
          ),
        );

        await expect(scanner.assertPageAllowed(page)).resolves.toBeUndefined();
        expect(page.close).not.toHaveBeenCalled();
      });
    });

    describe('in a popup', () => {
      /** A page and the popup it opened. */
      const openPopup = () => {
        const opener = context.newPage();
        const popup = context.newPage();
        popup.openedBy = opener;
        return { opener, popup };
      };

      it('rejects the page that opened the popup too', async () => {
        const scanner = build(false);
        await scanner.createContext(browser as any);
        const { opener, popup } = openPopup();
        const bystander = context.newPage();

        context.requestListener!(
          makeRequest('http://10.0.0.5/', popup, 'https://b.example/r'),
        );

        await expect(scanner.assertPageAllowed(opener)).rejects.toThrow(
          /popup.*10\.0\.0\.5/,
        );
        expect(popup.close).toHaveBeenCalled();
        await expect(
          scanner.assertPageAllowed(bystander),
        ).resolves.toBeUndefined();
      });

      it("makes the opener wait for its popup's checks", async () => {
        const scanner = build(false);
        await scanner.createContext(browser as any);
        const { opener, popup } = openPopup();
        let answer!: (result: unknown) => void;
        urlPolicy.isAllowedTarget.mockReturnValueOnce(
          new Promise((resolve) => {
            answer = resolve;
          }),
        );
        context.requestListener!(
          makeRequest('http://10.0.0.5/', popup, 'https://b.example/r'),
        );
        await flush();

        const check = scanner.assertPageAllowed(opener);
        await flush();
        answer(policyDecision('http://10.0.0.5/'));

        await expect(check).rejects.toThrow(TargetPolicyViolationError);
      });
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
