import { AxeAccessibilityScanner } from './axe-accessibility-scanner.service';
import type { UrlPolicyService } from './url-policy.service';

/** Minimal Playwright Route stub capturing continue/abort outcomes. */
function makeRoute(url: string) {
  return {
    request: () => ({ url: () => url }),
    continue: jest.fn().mockResolvedValue(undefined),
    abort: jest.fn().mockResolvedValue(undefined),
  };
}

describe('AxeAccessibilityScanner target-policy guard', () => {
  let routeHandler:
    | ((route: ReturnType<typeof makeRoute>) => Promise<void>)
    | undefined;
  let context: { route: jest.Mock };
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
    routeHandler = undefined;
    context = {
      route: jest.fn((_pattern: string, handler: any) => {
        routeHandler = handler;
        return Promise.resolve();
      }),
    };
    browser = { newContext: jest.fn().mockResolvedValue(context) };
    urlPolicy = { isAllowedTarget: jest.fn() };
  });

  it('does not intercept requests when private targets are allowed', async () => {
    const scanner = build(true);
    await scanner.createContext(browser as any);
    expect(context.route).not.toHaveBeenCalled();
  });

  it('installs a wildcard route when private targets are blocked', async () => {
    const scanner = build(false);
    await scanner.createContext(browser as any);
    expect(context.route).toHaveBeenCalledWith('**/*', expect.any(Function));
  });

  it('continues allowed HTTP(S) requests and aborts blocked ones', async () => {
    const scanner = build(false);
    await scanner.createContext(browser as any);

    urlPolicy.isAllowedTarget.mockResolvedValueOnce({ allowed: true });
    const allowed = makeRoute('https://example.com/app.js');
    await routeHandler!(allowed);
    expect(allowed.continue).toHaveBeenCalled();
    expect(allowed.abort).not.toHaveBeenCalled();

    urlPolicy.isAllowedTarget.mockResolvedValueOnce({
      allowed: false,
      reason: 'address 169.254.169.254 is in a private or reserved range',
    });
    const blocked = makeRoute('http://169.254.169.254/latest/meta-data/');
    await routeHandler!(blocked);
    expect(blocked.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(blocked.continue).not.toHaveBeenCalled();
  });

  it('lets non-HTTP schemes through without a policy lookup', async () => {
    const scanner = build(false);
    await scanner.createContext(browser as any);

    const dataUri = makeRoute('data:image/png;base64,AAAA');
    await routeHandler!(dataUri);
    expect(dataUri.continue).toHaveBeenCalled();
    expect(urlPolicy.isAllowedTarget).not.toHaveBeenCalled();
  });

  it('aborts requests whose URL cannot be parsed', async () => {
    const scanner = build(false);
    await scanner.createContext(browser as any);

    const bad = makeRoute('not a url');
    await routeHandler!(bad);
    expect(bad.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(urlPolicy.isAllowedTarget).not.toHaveBeenCalled();
  });

  it('caches the policy decision per host', async () => {
    const scanner = build(false);
    await scanner.createContext(browser as any);

    urlPolicy.isAllowedTarget.mockResolvedValue({ allowed: true });
    await routeHandler!(makeRoute('https://example.com/a.css'));
    await routeHandler!(makeRoute('https://example.com/b.js'));
    await routeHandler!(makeRoute('https://example.com/c.png'));

    // Same host → resolved once, then served from the per-context cache.
    expect(urlPolicy.isAllowedTarget).toHaveBeenCalledTimes(1);
  });
});
