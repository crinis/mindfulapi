import { Injectable, Logger } from '@nestjs/common';
import { Browser, BrowserContextOptions, Page } from 'playwright';
import { kayle, RunnerConfig, Issue as KayleIssue } from 'kayle';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import * as fs from 'fs/promises';
import { IAccessibilityScanner, ScanOptions } from '../interfaces';
import { Issue } from '../entities/issue.entity';
import { IssueImpact } from '../enums/issue-impact.enum';

/**
 * HTML_CodeSniffer accessibility scanner implementation using Kayle library.
 * 
 * This service provides comprehensive web accessibility scanning by integrating the
 * HTML_CodeSniffer accessibility testing engine through the Kayle runner. It performs
 * automated accessibility audits against WCAG 2.1 AA standards and captures visual
 * context through automated screenshot generation.
 * 
 * Key features:
 * - Automated accessibility scanning using HTML_CodeSniffer rules
 * - Visual issue documentation with element-specific screenshots
 * - Support for authenticated pages via basic auth and custom headers
 * - Configurable screenshot storage with automatic directory management
 * - Comprehensive error handling and logging for debugging
 * - Integration with Playwright for reliable browser automation
 * 
 * The scanner identifies three types of accessibility issues:
 * - Errors: WCAG violations that prevent accessibility
 * - Warnings: Potential accessibility issues requiring manual review
 * - Notices: Accessibility best practice recommendations
 * 
 * @implements {IAccessibilityScanner}
 */
@Injectable()
export class HtmlcsAccessibilityScanner implements IAccessibilityScanner {
  private readonly logger = new Logger(HtmlcsAccessibilityScanner.name);

  /**
   * Retrieves the configured screenshot directory path from environment variables.
   * 
   * Uses SCREENSHOT_DIR environment variable if set, otherwise defaults to './screenshots'
   * in the project root. The path is resolved to an absolute path for consistent access.
   * 
   * @returns The resolved absolute path to the screenshot directory
   */
  private getScreenshotDirectory(): string {
    // Use screenshots directory in project root by default for testing
    // This provides a good default for testing and development
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
  private async ensureScreenshotDirectory(dir: string): Promise<void> {
    try {
      await fs.access(dir);
    } catch {
      await fs.mkdir(dir, { recursive: true });
      this.logger.log(`Created screenshot directory: ${dir}`);
    }
  }

  /**
   * Performs comprehensive accessibility scanning of a web page using HTML_CodeSniffer.
   * 
   * This method orchestrates the complete scanning process including:
   * - Browser context configuration with authentication and headers
   * - Page loading and accessibility rule execution via Kayle
   * - Element-specific screenshot capture for visual issue context
   * - Issue conversion to internal entity format
   * 
   * The scanner runs HTML_CodeSniffer rules against WCAG 2.1 AA standards,
   * identifying accessibility violations, warnings, and notices. Each issue
   * is documented with contextual information and visual screenshots when possible.
   * 
   * Authentication and headers are configured at the browser context level,
   * ensuring they apply to the main page and any resources it loads.
   * 
   * @param url - The target URL to scan for accessibility issues
   * @param browser - Playwright browser instance for page automation
   * @param options - Optional scan configuration including authentication and headers
   * @returns Promise resolving to partial Issue entities ready for database storage
   * @throws {Error} When page loading, scanning, or screenshot capture fails
   */
  async scan(
    url: string,
    browser: Browser,
    options?: ScanOptions,
  ): Promise<Partial<Issue>[]> {
    this.logger.log(`Starting HTMLCS accessibility scan for URL: ${url}`);

    try {
      // Setup screenshot directory
      const screenshotDir = this.getScreenshotDirectory();
      await this.ensureScreenshotDirectory(screenshotDir);

      // Create browser context with HTTP credentials and headers if provided
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

      try {
        // Configure kayle options without screenshot support (we'll handle screenshots manually)
        const kayleOptions: RunnerConfig = {
          // Type assertion needed due to Playwright vs Kayle interface compatibility
          // Kayle expects Partial<Page> while Playwright provides a more specific Page type
          page: page as RunnerConfig['page'],
          browser,
          includeWarnings: true,
          origin: url,
          waitUntil: 'domcontentloaded',
          allowImages: true,
          clip: false, // Disable Kayle's screenshot functionality
          language: 'en', // used for fallback descriptions
        };

        // Debug log Kayle configuration
        this.logger.debug(
          `Kayle configuration: ${JSON.stringify(
            {
              ...kayleOptions,
              page: '[Playwright Page Object]', // Don't stringify the page object
              browser: '[Playwright Browser Object]', // Don't stringify the browser object
            },
            null,
            2,
          )}`,
        );

        // Run the accessibility scan
        const results = await kayle(kayleOptions, true);

        // Take custom screenshots for each issue
        const issuesWithScreenshots = await this.takeScreenshots(
          page,
          results.issues,
          screenshotDir,
        );

        // Log raw results for debugging (temporarily always enabled for testing)
        this.logger.debug(
          `Raw Kayle scan results for ${url}: ${JSON.stringify(results, null, 2)}`,
        );

        // Convert results to issue entities with screenshots
        const issues = this.convertKayleIssuesToIssues(issuesWithScreenshots);

        this.logger.log(
          `HTMLCS scan completed. Found ${issues.length} issues for URL: ${url}`,
        );

        return issues;
      } finally {
        // Always close context, even if an error occurs
        await context.close();
      }
    } catch (error) {
      this.logger.error(`Failed to scan URL ${url}:`, error);
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Accessibility scan failed: ${errorMessage}`);
    }
  }

  /**
   * Captures element-specific screenshots for accessibility issues using Playwright.
   * 
   * This method enhances accessibility reports by providing visual context for each
   * identified issue. Screenshots help developers understand the visual impact of
   * accessibility problems and locate them more easily during remediation.
   * 
   * Processing behavior:
   * - Validates page availability before screenshot attempts
   * - Skips generic selectors (html, body) that provide no useful context
   * - Generates unique filenames using UUIDs to prevent conflicts
   * - Applies 5-second timeout per screenshot to prevent hanging
   * - Continues processing other issues if individual screenshots fail
   * 
   * @param page - Active Playwright page instance with loaded content
   * @param kayleIssues - Array of accessibility issues from Kayle scan results
   * @param screenshotDir - Absolute path to directory for screenshot storage
   * @returns Promise resolving to issues array with screenshot filenames added
   */
  private async takeScreenshots(
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
      // Return issues without screenshots if page is closed
      return kayleIssues.map((issue) => ({
        ...issue,
        screenshotFilename: undefined,
      }));
    }

    for (const issue of kayleIssues) {
      const issueWithScreenshot: KayleIssue & { screenshotFilename?: string } =
        {
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
          `Skipping screenshot for issue with selector: ${issue.selector}`,
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
        // Log the error but continue processing other issues
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
   * Converts Kayle scan results into internal Issue entity format.
   * 
   * This method transforms raw HTML_CodeSniffer results from the Kayle runner into
   * the application's internal Issue entity structure. It preserves all essential
   * accessibility information while adapting the data format for database storage
   * and API consumption.
   * 
   * Transformation includes:
   * - Rule ID mapping from Kayle code to internal ruleId field
   * - Message preservation as issue description
   * - Impact level conversion from Kayle types to internal enum
   * - CSS selector and HTML context preservation for issue location
   * - Screenshot filename association when available
   * 
   * Debug logging is enabled in development environments to aid troubleshooting.
   * 
   * @param kayleIssues - Array of Kayle issues with optional screenshot filenames
   * @returns Array of partial Issue entities ready for database persistence
   */
  private convertKayleIssuesToIssues(
    kayleIssues: (KayleIssue & { screenshotFilename?: string })[],
  ): Partial<Issue>[] {
    if (!kayleIssues || kayleIssues.length === 0) {
      this.logger.warn('No accessibility issues found in scan results');
      return [];
    }

    // Log raw issues for debugging and monitoring in development
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
      // Create partial Issue using Kayle's Issue type properties
      // Note: scan relationship will be set by the processor
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
      `Converted ${issues.length} Kayle issues to partial Issues (no filtering applied)`,
    );
    return issues;
  }

  /**
   * Maps Kayle issue severity types to internal IssueImpact enum values.
   * 
   * HTML_CodeSniffer (via Kayle) classifies accessibility issues using three severity
   * levels that correspond to different WCAG conformance requirements:
   * - error: WCAG violations that prevent accessibility (must fix)
   * - warning: Potential issues requiring manual review (should investigate)
   * - notice: Best practice recommendations (consider addressing)
   * 
   * This mapping ensures consistent impact categorization across the application
   * while preserving the semantic meaning from the accessibility scanner.
   * 
   * @param kayleType - The severity classification from Kayle scan results
   * @returns Corresponding IssueImpact enum value for internal use
   * @throws {Error} When an unknown Kayle type is encountered (should never occur due to type constraints)
   */
  private mapKayleTypeToImpact(
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
        // This should never happen due to the type constraint, but included for completeness
        throw new Error(
          `Unknown Kayle issue type: "${String(kayleType)}". Expected one of: "error", "warning", "notice"`,
        );
    }
  }
}
