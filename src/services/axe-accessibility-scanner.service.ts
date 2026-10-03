import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Page,
  Request,
  Route,
  WebSocketRoute,
} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import type { AxeResults } from 'axe-core';
import { IssueImpact } from '../enums/issue-impact.enum';
import { scanConfig } from '../config/configuration';
import {
  TargetPolicyBlockCode,
  TargetPolicyResult,
  UrlPolicyService,
} from './url-policy.service';

export interface BasicAuth {
  /** Username used for HTTP Basic Authentication. */
  username: string;
  /** Password used for HTTP Basic Authentication. */
  password: string;
}

/** Basic Auth credentials bound to the one origin they may be sent to. */
export interface ScopedBasicAuth extends BasicAuth {
  /** Origin (scheme://host[:port]) whose 401 challenges are answered. */
  origin: string;
}

/**
 * Options for an axe-core accessibility scan.
 */
export interface ScanOptions {
  /** Specific axe rule IDs to run. When empty, all rules run. */
  ruleIds?: string[];
  /** HTTP Basic Authentication credentials, scoped to one origin. */
  basicAuth?: ScopedBasicAuth;
  /** CSS selector to limit scan scope. Scans entire page when omitted. */
  rootElement?: string;
}

export interface ScannedIssue {
  /** Axe rule ID producing this issue occurrence. */
  ruleId: string;
  /** Human-readable rule description/help text. */
  description: string;
  /** Normalized severity level for the issue occurrence. */
  impact: IssueImpact;
  /** URL of the analyzed page where the issue was found. */
  pageUrl: string;
  /** Optional CSS selector for the target element. */
  selector?: string;
  /** Optional HTML snippet of the target element. */
  context?: string;
  /** Optional external help URL for remediation guidance. */
  helpUrl?: string;
}

export interface ScanPageResult {
  /** Final URL after navigation (after redirects). */
  finalUrl: string;
  /** Issue occurrences discovered on the analyzed page. */
  issues: ScannedIssue[];
}

/**
 * A page whose content must not be analysed or stored — it is not content of
 * the scanned site. Callers count it as a failed page and must not mine it for
 * links or AI-audit evidence.
 */
export class PageRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The navigation ended on an HTTP error page (status >= 400) or without a response. */
export class PageNavigationError extends PageRejectedError {}

/** The page reached a target blocked by the URL policy (e.g. via a redirect). */
export class TargetPolicyViolationError extends PageRejectedError {}

/** WebSocket close code for "policy violation" (RFC 6455 §7.4.1). */
const WS_POLICY_VIOLATION = 1008;

/**
 * Block codes that carry no verdict about the address the browser connects
 * to: the policy could not resolve the name, or got the answer DNS filters
 * give for blocked names. The browser resolves names on its own and normally
 * fails such a request too (`net::ERR_NAME_NOT_RESOLVED`, or nothing listening
 * at the unspecified address), so a redirect hop to such a host is held against
 * its page only when the browser got a response.
 */
const UNVETTED_CODES: ReadonlySet<TargetPolicyBlockCode | undefined> = new Set([
  'unresolvable',
  'lookup_failed',
  'null_route',
]);

/** Target-policy violations the guard observed for one page. */
interface PageGuardState {
  /** First violation observed for the page, if any. */
  violation?: string;
  /** Closing of the page, started when the violation was recorded. */
  closing?: Promise<void>;
  /** Settles when the first violation is recorded. */
  violated: Promise<void>;
  /** Settles {@link violated}. */
  markViolated: () => void;
  /** Policy checks still in flight for requests attributed to the page. */
  pending: Set<Promise<void>>;
}

/** Target-policy guard state shared by all pages of one browser context. */
interface ContextGuard {
  /**
   * Policy decision for a URL, resolved at most once per host — except a
   * failed lookup, which the next request for the host repeats.
   */
  decide(url: string): Promise<TargetPolicyResult>;
  /** Violation state of a page, created on first use. */
  stateOf(page: Page): PageGuardState;
}

/**
 * Axe-core accessibility scanner using @axe-core/playwright.
 */
@Injectable()
export class AxeAccessibilityScanner {
  /** Service logger for scan lifecycle and diagnostics. */
  private readonly logger = new Logger(AxeAccessibilityScanner.name);
  /** Guards of the contexts created with the target policy enforced. */
  private readonly guards = new WeakMap<BrowserContext, ContextGuard>();

  /**
   * @param config Scan namespace configuration (TLS error handling, SSRF flags).
   * @param urlPolicy Target policy used to vet every browser request.
   */
  constructor(
    @Inject(scanConfig.KEY)
    private readonly config: ConfigType<typeof scanConfig>,
    private readonly urlPolicy: UrlPolicyService,
  ) {}

  /**
   * Creates a browser context configured for scan options such as basic auth.
   * When private targets are not allowed the target-policy guard is installed
   * (see {@link installTargetPolicyGuard}).
   *
   * @param browser Playwright browser instance.
   * @param options Optional scan configuration.
   */
  async createContext(
    browser: Browser,
    options?: ScanOptions,
  ): Promise<BrowserContext> {
    const contextOptions: BrowserContextOptions = {
      ignoreHTTPSErrors: this.config.ignoreHttpsErrors,
      // Deliberately not 'block': in Playwright 1.60 (Chromium) 'block' only
      // replaces navigator.serviceWorker.register in pages — a page can still
      // register through ServiceWorkerContainer.prototype.register — and it
      // switches off request interception for service workers. With 'allow',
      // service-worker requests pass the context route and request listener
      // like page requests.
      serviceWorkers: 'allow',
    };

    if (options?.basicAuth) {
      // Without an origin Playwright answers every Basic challenge with these
      // credentials — cross-origin subresources and redirect targets too.
      contextOptions.httpCredentials = {
        username: options.basicAuth.username,
        password: options.basicAuth.password,
        origin: options.basicAuth.origin,
      };
    }

    const context = await browser.newContext(contextOptions);

    // When private targets are allowed everything is permitted, so skip the
    // per-request interception entirely to avoid its overhead.
    if (!this.config.allowPrivateTargets) {
      await this.installTargetPolicyGuard(context);
    }

    return context;
  }

  /**
   * Enforces {@link UrlPolicyService} on everything a page of the context can
   * reach, so a permitted public page cannot pivot to a private/reserved
   * address:
   *
   * - Every request the browser starts (navigations, iframes, subresources,
   *   fetch/XHR, worker requests) is checked by a route handler and aborted
   *   before it is sent when its host is blocked.
   * - Redirect hops are never passed to route handlers — Playwright continues
   *   them itself — so they cannot be stopped in flight. A request listener
   *   checks every hop instead; a hop to a host that is or resolves to a
   *   private or reserved address marks its page as violating and closes it.
   *   {@link assertPageAllowed} then rejects the page, so the scanner never
   *   analyses, stores or sends to the AI audit anything it loaded. The hop's
   *   request has already been sent and its response reaches the browser,
   *   though: a malicious page's own script can read a CORS-readable response
   *   from the blocked host and exfiltrate it before the close completes. The
   *   host is generally not yet in the decision cache when the hop fires (the
   *   hop is the first contact with it), so the close cannot be made
   *   synchronous; fully closing this needs an egress proxy.
   * - A hop to a host the policy has no verdict on (see {@link UNVETTED_CODES}:
   *   the name does not resolve, the lookup failed, or a DNS filter answered
   *   `0.0.0.0`) counts only when the browser got a response from it: the
   *   browser then reached a host the policy could not vet. When the browser
   *   failed the hop as well, nothing reached the page, and the page stays
   *   scannable, as a broken image or frame of an otherwise public page.
   * - WebSockets opened by pages are checked before they connect. This is
   *   Playwright's page-level `WebSocket` shim: it does not reach dedicated
   *   workers, and page script can get past it, so it is defence in depth,
   *   not a boundary (see the README on the Playwright run-server).
   * - APIs whose connections Playwright neither routes nor reports are removed
   *   from every document: `SharedWorker`, `WebSocketStream`, `WebTransport`
   *   and the WebRTC peer connection. Init scripts do not run in dedicated
   *   workers, which keep `WebSocket`, `WebSocketStream` and `WebTransport`.
   *   Service workers stay enabled because their requests are routed (see
   *   {@link createContext}).
   *
   * Decisions are cached per host for the context's lifetime, so each distinct
   * host is resolved at most once; a failed lookup is not kept, so the next
   * request for the host asks again. The browser resolves DNS independently
   * of the policy check, so DNS rebinding remains the documented limitation.
   */
  private async installTargetPolicyGuard(
    context: BrowserContext,
  ): Promise<void> {
    const guard = this.createContextGuard();
    this.guards.set(context, guard);

    await context.route('**/*', (route) => this.guardRequest(route, guard));
    context.on('request', (request) =>
      this.guardRedirectHop(request, context, guard),
    );
    await context.routeWebSocket(/.*/, (webSocket) =>
      this.guardWebSocket(webSocket, guard),
    );
    // Serialized into every document, so it must stay self-contained.
    await context.addInitScript(() => {
      const scope = globalThis as Record<string, unknown>;
      for (const name of [
        'SharedWorker',
        'WebSocketStream',
        'WebTransport',
        'RTCPeerConnection',
        'webkitRTCPeerConnection',
      ]) {
        delete scope[name];
      }
    });
  }

  /** Creates the per-context decision cache and page violation registry. */
  private createContextGuard(): ContextGuard {
    const decisionByHost = new Map<string, Promise<TargetPolicyResult>>();
    const stateByPage = new WeakMap<Page, PageGuardState>();

    return {
      decide: (url) => {
        let host: string;
        try {
          host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
        } catch {
          return Promise.resolve({
            allowed: false,
            code: 'invalid_url',
            reason: 'invalid URL',
          });
        }
        const cached = decisionByHost.get(host);
        if (cached) return cached;

        const decision: Promise<TargetPolicyResult> = this.urlPolicy
          .isAllowedTarget(url)
          .catch(
            (error: unknown): TargetPolicyResult => ({
              allowed: false,
              code: 'lookup_failed',
              reason: `policy check failed: ${String(error)}`,
            }),
          )
          .then((result) => {
            if (result.code === 'lookup_failed') {
              // Requests made while the lookup ran share it; later ones ask
              // again instead of failing for the rest of the scan.
              if (decisionByHost.get(host) === decision) {
                decisionByHost.delete(host);
              }
            }
            if (!result.allowed) {
              const message = `Blocked browser access to ${url}: ${result.reason ?? 'target not allowed'}`;
              if (UNVETTED_CODES.has(result.code)) this.logger.debug(message);
              else this.logger.warn(message);
            }
            return result;
          });
        decisionByHost.set(host, decision);
        return decision;
      },
      stateOf: (page) => {
        let state = stateByPage.get(page);
        if (!state) {
          let markViolated!: () => void;
          const violated = new Promise<void>((resolve) => {
            markViolated = resolve;
          });
          state = { pending: new Set(), violated, markViolated };
          stateByPage.set(page, state);
        }
        return state;
      },
    };
  }

  /** Route handler: aborts any HTTP(S) request whose host is blocked. */
  private async guardRequest(route: Route, guard: ContextGuard): Promise<void> {
    const requestUrl = route.request().url();
    let protocol: string;
    try {
      protocol = new URL(requestUrl).protocol;
    } catch {
      await route.abort('blockedbyclient');
      return;
    }

    // Only HTTP(S) requests carry SSRF risk here; let the browser handle
    // data:/blob:/about: and other schemes normally.
    if (protocol !== 'http:' && protocol !== 'https:') {
      await route.continue();
      return;
    }

    const decision = await guard.decide(requestUrl);
    await (decision.allowed
      ? route.continue()
      : route.abort('blockedbyclient'));
  }

  /**
   * Request listener: checks redirect hops, which bypass the route handler,
   * and marks the originating page as violating when a hop is blocked. First
   * hops are left to the route handler, which already aborted blocked ones.
   */
  private guardRedirectHop(
    request: Request,
    context: BrowserContext,
    guard: ContextGuard,
  ): void {
    const redirectedFrom = request.redirectedFrom();
    const url = request.url();
    if (!redirectedFrom || !/^https?:/i.test(url)) {
      return;
    }

    const pages = this.pagesOf(request, context);
    const check = this.checkRedirectHop(request, url, guard).then(
      (violation) => {
        if (!violation) return;
        const reason = `redirect from ${redirectedFrom.url()} reached ${violation}`;
        for (const page of pages) {
          this.flagViolation(guard, page, reason);
        }
      },
    );

    for (const page of pages) {
      const { pending } = guard.stateOf(page);
      pending.add(check);
      void check.finally(() => pending.delete(check));
    }
  }

  /**
   * Decides whether a redirect hop violates the target policy.
   *
   * A host that is (or resolves to) a private or reserved address violates it
   * at once. A host the policy has no verdict on ({@link UNVETTED_CODES})
   * violates it only once the browser got a response from it; the decision is
   * then taken again, because a failed lookup is not cached and may succeed
   * now. A hop the browser failed as well (or that was still open when its
   * page closed) reached nothing.
   *
   * @returns What the hop reached, for the violation message, or `null`.
   */
  private async checkRedirectHop(
    request: Request,
    url: string,
    guard: ContextGuard,
  ): Promise<string | null> {
    let decision = await guard.decide(url);
    if (decision.allowed) return null;

    if (UNVETTED_CODES.has(decision.code)) {
      const answered = await request.response().then(
        (response) => response !== null,
        () => false,
      );
      if (!answered) return null;
      decision = await guard.decide(url);
      if (decision.allowed) return null;
      if (UNVETTED_CODES.has(decision.code)) {
        return `${url}, which answered the browser although the target policy could not vet it (${decision.reason ?? 'target not allowed'})`;
      }
    }
    return `blocked target ${url} (${decision.reason ?? 'target not allowed'})`;
  }

  /**
   * Page that issued a request; every open page of the context when the
   * request cannot be attributed (e.g. a worker without a frame).
   */
  private pagesOf(request: Request, context: BrowserContext): Page[] {
    try {
      const page = request.frame().page();
      if (page) return [page];
    } catch {
      // Requests without a frame (service workers) throw here.
    }
    return context.pages();
  }

  /** Records the first violation of a page and closes it to stop it loading. */
  private flagViolation(guard: ContextGuard, page: Page, reason: string): void {
    const state = guard.stateOf(page);
    if (state.violation) return;
    state.violation = reason;
    this.logger.warn(
      `Rejecting page after a target-policy violation: ${reason}`,
    );
    state.closing = page.close().catch(() => undefined);
    state.markViolated();
  }

  /** WebSocket route: connects only sockets whose host is allowed. */
  private async guardWebSocket(
    webSocket: WebSocketRoute,
    guard: ContextGuard,
  ): Promise<void> {
    const decision = await guard.decide(webSocket.url());
    if (decision.allowed) {
      webSocket.connectToServer();
      return;
    }
    await webSocket.close({
      code: WS_POLICY_VIOLATION,
      reason: 'Blocked by the scan target policy',
    });
  }

  /**
   * Navigates to a URL and analyzes the resulting loaded page.
   *
   * @param page Playwright page instance.
   * @param url Target URL to navigate/analyze.
   * @param options Optional scan configuration.
   * @throws PageRejectedError When the page must not be analysed (see
   * {@link openPage} and {@link assertPageAllowed}).
   */
  async scanPage(
    page: Page,
    url: string,
    options?: ScanOptions,
  ): Promise<ScanPageResult> {
    this.logger.log(`Starting axe scan for URL: ${url}`);

    const { finalUrl } = await this.openPage(page, url);
    return this.analyzeLoadedPage(page, options, finalUrl);
  }

  /**
   * Navigates to a URL and verifies the navigation produced a page worth
   * analysing.
   *
   * @param page Playwright page instance.
   * @param url Target URL to navigate to.
   * @returns The final URL (after redirects) and its HTTP status.
   * @throws TargetPolicyViolationError When the navigation (or a request it
   * triggered) reached a blocked target — checked first, including the final
   * URL.
   * @throws PageNavigationError When the final response is an HTTP error
   * (status >= 400) or the navigation produced no response — an error page is
   * not content of the scanned site.
   */
  async openPage(
    page: Page,
    url: string,
  ): Promise<{ finalUrl: string; status: number }> {
    let response: Awaited<ReturnType<Page['goto']>>;
    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (error) {
      // The guard closes a page as soon as it follows a redirect to a blocked
      // target; report that rather than the resulting navigation error.
      await this.assertPageAllowed(page);
      throw error;
    }
    await this.assertPageAllowed(page);

    if (!response) {
      throw new PageNavigationError(
        `Navigation to ${url} produced no response`,
      );
    }
    const status = response.status();
    const finalUrl = page.url();
    if (status >= 400) {
      throw new PageNavigationError(
        `Navigation to ${url} ended with HTTP ${status}${finalUrl !== url ? ` at ${finalUrl}` : ''}`,
      );
    }
    return { finalUrl, status };
  }

  /**
   * Verifies a page has not reached a target blocked by the URL policy: no
   * redirect hop it followed so far was blocked, and its current URL is
   * allowed. Call it after every phase that lets the page load more (analysis,
   * evidence collection) and before anything read from the page is stored or
   * followed. A no-op when private targets are allowed.
   *
   * @throws TargetPolicyViolationError When the page violated the policy.
   */
  async assertPageAllowed(page: Page): Promise<void> {
    const guard = this.guards.get(page.context());
    if (!guard) return;

    const state = guard.stateOf(page);
    // A check may wait for the outcome of its request (see checkRedirectHop);
    // a violation found meanwhile is reported without waiting for the rest.
    while (!state.violation && state.pending.size > 0) {
      await Promise.race([
        Promise.allSettled([...state.pending]),
        state.violated,
      ]);
    }
    if (state.violation) {
      await state.closing;
      throw new TargetPolicyViolationError(state.violation);
    }

    const finalUrl = page.url();
    if (!/^https?:/i.test(finalUrl)) return;
    const decision = await guard.decide(finalUrl);
    if (!decision.allowed) {
      const reason = `page ended on blocked target ${finalUrl} (${decision.reason ?? 'target not allowed'})`;
      this.flagViolation(guard, page, reason);
      await state.closing;
      throw new TargetPolicyViolationError(reason);
    }
  }

  /**
   * Runs axe analysis on an already loaded page without additional navigation.
   *
   * @param page Loaded Playwright page instance.
   * @param options Optional scan configuration.
   * @param pageUrl Optional explicit URL override for persisted issue records.
   * @throws TargetPolicyViolationError When the page violated the target
   * policy before or during the analysis; its results are discarded.
   */
  async analyzeLoadedPage(
    page: Page,
    options?: ScanOptions,
    pageUrl?: string,
  ): Promise<ScanPageResult> {
    await this.assertPageAllowed(page);

    const finalUrl = pageUrl || page.url();
    let axeBuilder = new AxeBuilder({ page });

    if (options?.rootElement) {
      axeBuilder = axeBuilder.include(options.rootElement);
    }

    if (options?.ruleIds && options.ruleIds.length > 0) {
      axeBuilder = axeBuilder.withRules(options.ruleIds);
    }

    let results: AxeResults;
    try {
      results = await axeBuilder.analyze();
    } catch (error) {
      await this.assertPageAllowed(page);
      throw error;
    }
    // Subresources loaded during the analysis may have followed a redirect to
    // a blocked target.
    await this.assertPageAllowed(page);

    const issues: ScannedIssue[] = [];

    for (const violation of results.violations) {
      const impact = this.mapImpact(violation.impact);
      for (const node of violation.nodes) {
        issues.push({
          ruleId: violation.id,
          description: violation.help,
          impact,
          pageUrl: finalUrl,
          selector: node.target?.toString() || undefined,
          context: node.html || undefined,
          helpUrl: violation.helpUrl || undefined,
        });
      }
    }

    this.logger.log(
      `Axe scan completed. Found ${issues.length} issues for URL: ${finalUrl}`,
    );

    return { finalUrl, issues };
  }

  /**
   * Converts raw axe impact strings to the internal issue-impact enum.
   *
   * @param axeImpact Raw impact value returned by axe-core.
   */
  private mapImpact(axeImpact: string | null | undefined): IssueImpact {
    switch (axeImpact) {
      case 'critical':
        return IssueImpact.CRITICAL;
      case 'serious':
        return IssueImpact.SERIOUS;
      case 'moderate':
        return IssueImpact.MODERATE;
      case 'minor':
        return IssueImpact.MINOR;
      default:
        return IssueImpact.SERIOUS;
    }
  }
}
