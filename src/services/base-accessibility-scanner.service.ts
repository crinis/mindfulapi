import { Injectable, Logger } from '@nestjs/common';
import { Browser, BrowserContextOptions, Page } from 'playwright';
import { kayle, RunnerConfig, Issue as KayleIssue } from 'kayle';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import * as fs from 'fs/promises';
import { ScanOptions } from '../interfaces';
import { Issue } from '../entities/issue.entity';
import { IssueImpact } from '../enums/issue-impact.enum';

/**
 * Base accessibility scanner service containing common functionality.
 * 
 * This abstract service provides shared methods for accessibility scanning
 * including screenshot management, browser context setup, and issue conversion.
 * Concrete implementations should extend this class and implement scanner-specific
 * logic for different accessibility testing engines.
 */
@Injectable()
export abstract class BaseAccessibilityScanner {
  protected readonly logger = new Logger(this.constructor.name);

  /**
   * Retrieves the configured screenshot directory path from environment variables.
   * 
   * Uses SCREENSHOT_DIR environment variable if set, otherwise defaults to './screenshots'
   * in the project root. The path is resolved to an absolute path for consistent access.
   * 
   * @returns The resolved absolute path to the screenshot directory
   */
  protected getScreenshotDirectory(): string {
    const screenshotDir = process.env.SCREENSHOT_DIR || './screenshots';
    return path.resolve(screenshotDir);
  }

  /**
   * Ensures the screenshot directory exists, creating it if necessary.
   * 
   * Attempts to access the directory first, creating it recursively if it doesn't exist.
   * This prevents filesystem errors when saving screenshots during scanning.
   * 
   * @param dir - The absolute directory path to create
   */
  protected async ensureScreenshotDirectory(dir: string): Promise<void> {
    try {
      await fs.access(dir);
    } catch {
      await fs.mkdir(dir, { recursive: true });
      this.logger.log(`Created screenshot directory: ${dir}`);
    }
  }

  /**
   * Creates and configures a browser context with authentication and headers.
   * 
   * Sets up browser context with optional HTTP credentials and custom headers
   * for accessing protected pages during accessibility scanning.
   * 
   * @param browser - Playwright browser instance
   * @param options - Optional scan configuration including authentication and headers
   * @returns Configured browser context ready for page creation
   */
  protected async createBrowserContext(
    browser: Browser,
    options?: ScanOptions,
  ): Promise<{ context: any; page: Page }> {
    const contextOptions: BrowserContextOptions = {};
    
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
    
    return { context, page };
  }

  /**
   * Creates base Kayle configuration common to all accessibility scanners.
   * 
   * Generates the basic RunnerConfig with common settings that can be extended
   * by specific scanner implementations with their own runner configurations.
   * 
   * @param page - Playwright page instance
   * @param browser - Playwright browser instance  
   * @param url - Target URL being scanned
   * @param options - Optional scan configuration
   * @returns Base RunnerConfig ready for extension
   */
  protected createBaseKayleConfig(
    page: Page,
    browser: Browser,
    url: string,
    options?: ScanOptions,
  ): RunnerConfig {
    const kayleOptions: RunnerConfig = {
      page: page as RunnerConfig['page'],
      browser,
      includeWarnings: true,
      origin: url,
      waitUntil: 'domcontentloaded',
      allowImages: true,
      clip: false, // Disable Kayle's screenshot functionality
      language: 'en',
    };

    // Only set rootElement if it was explicitly provided
    if (options?.rootElement) {
      kayleOptions.rootElement = options.rootElement;
    }

    return kayleOptions;
  }

  /**
   * Captures element-specific screenshots for accessibility issues using Playwright.
   * 
   * This method enhances accessibility reports by providing visual context for each
   * identified issue. Screenshots help developers understand the visual impact of
   * accessibility problems and locate them more easily during remediation.
   * 
   * @param page - Active Playwright page instance with loaded content
   * @param kayleIssues - Array of accessibility issues from Kayle scan results
   * @param screenshotDir - Absolute path to directory for screenshot storage
   * @returns Promise resolving to issues array with screenshot filenames added
   */
  protected async takeScreenshots(
    page: Page,
    kayleIssues: KayleIssue[],
    screenshotDir: string,
  ): Promise<(KayleIssue & { screenshotFilename?: string })[]> {
    const issuesWithScreenshots: (KayleIssue & {
      screenshotFilename?: string;
    })[] = [];

    // Check if page is still open before taking screenshots
    try {
      await page.evaluate(() => document.readyState);
    } catch (error) {
      this.logger.error('Page is closed, cannot take screenshots:', error);
      return kayleIssues.map((issue) => ({
        ...issue,
        screenshotFilename: undefined,
      }));
    }

    for (const issue of kayleIssues) {
      const issueWithScreenshot: KayleIssue & { screenshotFilename?: string } = {
        ...issue,
        screenshotFilename: undefined,
      };

      // Skip if no selector or if selector is too generic
      if (
        !issue.selector ||
        issue.selector === 'html' ||
        issue.selector === 'body'
      ) {
        this.logger.debug(
          `Skipping screenshot for selector: ${issue.selector}`,
        );
        issuesWithScreenshots.push(issueWithScreenshot);
        continue;
      }

      try {
        // Generate unique filename using UUID
        const fileName = `${uuidv4()}.png`;
        const storagePath = path.join(screenshotDir, fileName);

        // Try to locate and screenshot the element
        const element = page.locator(issue.selector);

        // Take screenshot of the specific element
        await element.screenshot({
          path: storagePath,
          timeout: 5000, // 5 second timeout
        });

        issueWithScreenshot.screenshotFilename = fileName;
        this.logger.debug(
          `Screenshot taken for selector '${issue.selector}': ${fileName}`,
        );
      } catch (error) {
        this.logger.warn(
          `Failed to take screenshot for selector '${issue.selector}':`,
          error,
        );
      }

      issuesWithScreenshots.push(issueWithScreenshot);
    }

    this.logger.log(
      `Took screenshots for ${issuesWithScreenshots.filter((i) => i.screenshotFilename).length} out of ${kayleIssues.length} issues`,
    );
    return issuesWithScreenshots;
  }

  /**
   * Maps Kayle issue severity types to internal IssueImpact enum values.
   * 
   * @param kayleType - The severity classification from Kayle scan results
   * @returns Corresponding IssueImpact enum value for internal use
   */
  protected mapKayleTypeToImpact(
    kayleType: 'error' | 'warning' | 'notice',
  ): IssueImpact {
    switch (kayleType) {
      case 'error':
        return IssueImpact.ERROR;
      case 'warning':
        return IssueImpact.WARNING;
      case 'notice':
        return IssueImpact.NOTICE;
      default:
        throw new Error(
          `Unknown Kayle issue type: "${String(kayleType)}". Expected one of: "error", "warning", "notice"`,
        );
    }
  }

  /**
   * Converts Kayle scan results into internal Issue entity format.
   * 
   * This method transforms raw accessibility results from the Kayle runner into
   * the application's internal Issue entity structure, preserving all essential
   * accessibility information.
   * 
   * @param kayleIssues - Array of Kayle issues with optional screenshot filenames
   * @returns Array of partial Issue entities ready for database persistence
   */
  protected convertKayleIssuesToIssues(
    kayleIssues: (KayleIssue & { screenshotFilename?: string })[],
  ): Partial<Issue>[] {
    if (!kayleIssues || kayleIssues.length === 0) {
      this.logger.warn('No accessibility issues found in scan results');
      return [];
    }

    if (
      process.env.NODE_ENV === 'development' ||
      process.env.LOG_LEVEL === 'debug'
    ) {
      this.logger.debug(
        `Raw accessibility scan results: ${JSON.stringify(kayleIssues, null, 2)}`,
      );
    }
    
    this.logger.log(
      `Processing ${kayleIssues.length} raw accessibility issues`,
    );

    const issues: Partial<Issue>[] = [];

    for (const kayleIssue of kayleIssues) {
      const issue: Partial<Issue> = {
        ruleId: kayleIssue.code,
        description: kayleIssue.message,
        impact: this.mapKayleTypeToImpact(kayleIssue.type),
        selector: kayleIssue.selector || undefined,
        context: kayleIssue.context || undefined,
        screenshotFilename: kayleIssue.screenshotFilename || undefined,
      };

      issues.push(issue);
    }

    this.logger.log(
      `Converted ${issues.length} Kayle issues to partial Issues`,
    );
    
    return issues;
  }

  /**
   * Filters Kayle issues based on provided rule IDs.
   * 
   * When ruleIds are specified in ScanOptions, this method filters the scan results
   * to only include issues for those specific rules. If no ruleIds are provided,
   * all issues are returned unchanged.
   * 
   * @param kayleIssues - Array of Kayle issues from the scan
   * @param ruleIds - Optional array of rule IDs to filter by
   * @returns Filtered array of Kayle issues
   */
  protected filterIssuesByRules(
    kayleIssues: KayleIssue[],
    ruleIds?: string[],
  ): KayleIssue[] {
    if (!ruleIds || ruleIds.length === 0) {
      return kayleIssues;
    }

    const filteredIssues = kayleIssues.filter((issue) =>
      ruleIds.includes(issue.code),
    );

    this.logger.log(
      `Filtered ${kayleIssues.length} issues down to ${filteredIssues.length} issues based on ${ruleIds.length} specified rule IDs: ${ruleIds.join(', ')}`,
    );

    return filteredIssues;
  }

  /**
   * Runs Kayle with the provided configuration and handles results.
   * 
   * @param kayleOptions - Complete Kayle configuration
   * @param url - Target URL being scanned
   * @returns Promise resolving to Kayle scan results
   */
  protected async runKayleScan(
    kayleOptions: RunnerConfig,
    url: string,
  ): Promise<any> {
    this.logger.debug(
      `Kayle configuration: ${JSON.stringify(
        {
          ...kayleOptions,
          page: '[Playwright Page Object]',
          browser: '[Playwright Browser Object]',
        },
        null,
        2,
      )}`,
    );

    const results = await kayle(kayleOptions, true);

    this.logger.debug(
      `Raw Kayle scan results for ${url}: ${JSON.stringify(results, null, 2)}`,
    );

    return results;
  }
}
