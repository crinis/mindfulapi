import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Page,
  Route,
} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { IssueImpact } from '../enums/issue-impact.enum';
import { scanConfig } from '../config/configuration';
import { UrlPolicyService } from './url-policy.service';

export interface BasicAuth {
  /** Username used for HTTP Basic Authentication. */
  username: string;
  /** Password used for HTTP Basic Authentication. */
  password: string;
}

/**
 * Options for an axe-core accessibility scan.
 */
export interface ScanOptions {
  /** Specific axe rule IDs to run. When empty, all rules run. */
  ruleIds?: string[];
  /** HTTP Basic Authentication credentials. */
  basicAuth?: BasicAuth;
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
 * Axe-core accessibility scanner using @axe-core/playwright.
 */
@Injectable()
export class AxeAccessibilityScanner {
  /** Service logger for scan lifecycle and diagnostics. */
  private readonly logger = new Logger(AxeAccessibilityScanner.name);

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
   *
   * When private targets are not allowed, every request the browser makes
   * (main navigation, redirect hops, and all subresources) is vetted against
   * {@link UrlPolicyService}, so a permitted public page cannot redirect to — or
   * pull a subresource from — a private/reserved address. This does not close
   * the DNS-rebinding TOCTOU (the browser resolves independently of the policy
   * check); that remains the documented limitation.
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
    };

    if (options?.basicAuth) {
      contextOptions.httpCredentials = {
        username: options.basicAuth.username,
        password: options.basicAuth.password,
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
   * Aborts any browser request whose (HTTP/S) host violates the target policy.
   * Decisions are cached per host for the context's lifetime so each distinct
   * host is resolved at most once, keeping subresource-heavy pages cheap.
   */
  private async installTargetPolicyGuard(
    context: BrowserContext,
  ): Promise<void> {
    const decisionByHost = new Map<string, boolean>();

    await context.route('**/*', async (route: Route) => {
      const requestUrl = route.request().url();
      let parsed: URL;
      try {
        parsed = new URL(requestUrl);
      } catch {
        await route.abort('blockedbyclient');
        return;
      }

      // Only HTTP(S) requests carry SSRF risk here; let the browser handle
      // data:/blob:/about: and other schemes normally.
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        await route.continue();
        return;
      }

      const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      let allowed = decisionByHost.get(host);
      if (allowed === undefined) {
        const result = await this.urlPolicy.isAllowedTarget(requestUrl);
        allowed = result.allowed;
        decisionByHost.set(host, allowed);
        if (!allowed) {
          this.logger.warn(
            `Blocked browser request to ${requestUrl}: ${result.reason ?? 'target not allowed'}`,
          );
        }
      }

      await (allowed ? route.continue() : route.abort('blockedbyclient'));
    });
  }

  /**
   * Navigates to a URL and analyzes the resulting loaded page.
   *
   * @param page Playwright page instance.
   * @param url Target URL to navigate/analyze.
   * @param options Optional scan configuration.
   */
  async scanPage(
    page: Page,
    url: string,
    options?: ScanOptions,
  ): Promise<ScanPageResult> {
    this.logger.log(`Starting axe scan for URL: ${url}`);

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return this.analyzeLoadedPage(page, options, page.url());
  }

  /**
   * Runs axe analysis on an already loaded page without additional navigation.
   *
   * @param page Loaded Playwright page instance.
   * @param options Optional scan configuration.
   * @param pageUrl Optional explicit URL override for persisted issue records.
   */
  async analyzeLoadedPage(
    page: Page,
    options?: ScanOptions,
    pageUrl?: string,
  ): Promise<ScanPageResult> {
    const finalUrl = pageUrl || page.url();
    let axeBuilder = new AxeBuilder({ page });

    if (options?.rootElement) {
      axeBuilder = axeBuilder.include(options.rootElement);
    }

    if (options?.ruleIds && options.ruleIds.length > 0) {
      axeBuilder = axeBuilder.withRules(options.ruleIds);
    }

    const results = await axeBuilder.analyze();
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
