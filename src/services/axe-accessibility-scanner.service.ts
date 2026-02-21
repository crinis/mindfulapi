import { Injectable, Logger } from '@nestjs/common';
import { Browser, BrowserContextOptions } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { Issue } from '../entities/issue.entity';
import { IssueImpact } from '../enums/issue-impact.enum';

export interface BasicAuth {
  username: string;
  password: string;
}

/**
 * Options for an axe-core accessibility scan.
 */
export interface ScanOptions {
  /** Specific axe rule IDs to run. When empty, all rules run. */
  ruleIds?: string[];
  /** Custom HTTP headers to include with all page requests. */
  headers?: Record<string, string>;
  /** HTTP Basic Authentication credentials. */
  basicAuth?: BasicAuth;
  /** CSS selector to limit scan scope. Scans entire page when omitted. */
  rootElement?: string;
}

/**
 * Axe-core accessibility scanner using @axe-core/playwright.
 */
@Injectable()
export class AxeAccessibilityScanner {
  private readonly logger = new Logger(AxeAccessibilityScanner.name);

  async scan(
    url: string,
    browser: Browser,
    options?: ScanOptions,
  ): Promise<Partial<Issue>[]> {
    this.logger.log(`Starting axe scan for URL: ${url}`);

    const contextOptions: BrowserContextOptions = {
      ignoreHTTPSErrors: process.env.IGNORE_HTTPS_ERRORS === 'true',
    };

    if (options?.basicAuth) {
      contextOptions.httpCredentials = {
        username: options.basicAuth.username,
        password: options.basicAuth.password,
      };
    }

    if (options?.headers) {
      contextOptions.extraHTTPHeaders = options.headers;
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });

      let axeBuilder = new AxeBuilder({ page });

      if (options?.rootElement) {
        axeBuilder = axeBuilder.include(options.rootElement);
      }

      if (options?.ruleIds && options.ruleIds.length > 0) {
        axeBuilder = axeBuilder.withRules(options.ruleIds);
      }

      const results = await axeBuilder.analyze();

      const issues: Partial<Issue>[] = [];

      for (const violation of results.violations) {
        const impact = this.mapImpact(violation.impact);
        for (const node of violation.nodes) {
          issues.push({
            ruleId: violation.id,
            description: violation.help,
            impact,
            selector: node.target?.toString() || undefined,
            context: node.html || undefined,
            helpUrl: violation.helpUrl || undefined,
          });
        }
      }

      this.logger.log(
        `Axe scan completed. Found ${issues.length} issues for URL: ${url}`,
      );
      return issues;
    } finally {
      await context.close();
    }
  }

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
