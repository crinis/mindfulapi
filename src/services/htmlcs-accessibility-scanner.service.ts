import { Injectable } from '@nestjs/common';
import { Browser } from 'playwright';
import { RunnerConfig } from 'kayle';
import { IAccessibilityScanner, ScanOptions } from '../interfaces';
import { Issue } from '../entities/issue.entity';
import { BaseAccessibilityScanner } from './base-accessibility-scanner.service';

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
 * @extends {BaseAccessibilityScanner}
 */
@Injectable()
export class HtmlcsAccessibilityScanner extends BaseAccessibilityScanner implements IAccessibilityScanner {

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

      // Create browser context and page
      const { context, page } = await this.createBrowserContext(browser, options);

      try {
        // Create base Kayle configuration and add HTMLCS-specific rules
        const kayleOptions: RunnerConfig = {
          ...this.createBaseKayleConfig(page, browser, url, options)
        };

        // Run the accessibility scan
        const results = await this.runKayleScan(kayleOptions, url);

        // Filter issues by rule IDs if specified
        const filteredIssues = this.filterIssuesByRules(results.issues, options?.ruleIds);

        // Take custom screenshots for each issue
        const issuesWithScreenshots = await this.takeScreenshots(
          page,
          filteredIssues,
          screenshotDir,
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
}
