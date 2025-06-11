import { Browser } from 'playwright';
import { Issue } from '../entities/issue.entity';

/**
 * Interface contract for accessibility scanner implementations.
 * 
 * Defines the standard API for integrating different accessibility testing engines
 * into the application. Implementations should handle browser automation, page
 * scanning, and issue extraction while returning data in a consistent format.
 * 
 * The interface supports various scanning configurations including authentication,
 * custom headers, and timeouts to accommodate different testing scenarios and
 * protected web pages.
 * 
 * @example
 * ```typescript
 * class MyScanner implements IAccessibilityScanner {
 *   async scan(url: string, browser: Browser, options?: ScanOptions) {
 *     // Implementation specific scanning logic
 *     return partialIssues;
 *   }
 * }
 * ```
 */
export interface IAccessibilityScanner {
  /**
   * Performs comprehensive accessibility scanning of a web page.
   * 
   * This method should handle the complete scanning workflow including page
   * loading, accessibility rule execution, and result extraction. The browser
   * instance is provided for automation and should not be closed by the implementation.
   * 
   * Implementations must return partial Issue entities without scan relationships
   * as these will be established during persistence by the scan processor.
   * 
   * @param url - Target URL to analyze for accessibility violations
   * @param browser - Playwright browser instance for page automation and interaction
   * @param options - Optional configuration for authentication, timeouts, and scanning behavior
   * @returns Promise resolving to partial Issue entities ready for database persistence
   * @throws {Error} When page loading, scanning, or result processing fails
   */
  scan(
    url: string,
    browser: Browser,
    options?: ScanOptions,
  ): Promise<Partial<Issue>[]>;
}

/**
 * Authentication credentials for accessing protected web pages during scanning.
 * 
 * Used with HTTP Basic Authentication to scan pages that require login credentials.
 * Credentials are applied at the browser context level to ensure they work with
 * redirects and resource loading.
 */
export interface BasicAuth {
  /** Username for HTTP Basic Authentication */
  username: string;
  /** Password for HTTP Basic Authentication */
  password: string;
}

/**
 * Configuration options for customizing accessibility scan behavior.
 * 
 * Provides fine-grained control over scan execution including timeouts,
 * authentication, custom headers, and scope limitations. All options are
 * optional with sensible defaults applied by implementations.
 */
export interface ScanOptions {
  /**
   * Maximum time to wait for page loading and content rendering in milliseconds.
   * 
   * Prevents scans from hanging indefinitely on slow-loading pages while allowing
   * sufficient time for complex pages to fully render before accessibility analysis.
   * 
   * @default 30000 (30 seconds)
   */
  timeout?: number;

  /**
   * Specific accessibility rule IDs to execute during scanning.
   * 
   * When provided, only the specified rules will be run, allowing targeted
   * accessibility testing. If empty or undefined, all available rules will
   * be executed for comprehensive analysis.
   * 
   * @example ["WCAG2A.Principle1.Guideline1_1.1_1_1.H37"]
   */
  ruleIds?: string[];

  /**
   * Custom HTTP headers to include with all requests during scanning.
   * 
   * Useful for API authentication, custom user agents, or other request
   * modifications required for accessing target pages and resources.
   * 
   * @example { "Authorization": "Bearer token123", "User-Agent": "Custom Scanner" }
   */
  headers?: Record<string, string>;

  /**
   * HTTP Basic Authentication credentials for accessing protected pages.
   * 
   * Applied at the browser context level to handle authentication prompts
   * and protected resources throughout the scanning process.
   */
  basicAuth?: BasicAuth;

  /**
   * CSS selector to limit scanning scope to a specific page element.
   * 
   * When provided, accessibility analysis will focus only on the specified
   * element and its descendants. If not provided, the entire page will be scanned.
   * 
   * @example "#main-content" or ".accessibility-test-region"
   */
  rootElement?: string;

  /**
   * Directory path for storing visual evidence during scanning.
   * 
   * Screenshots and visual clips captured during accessibility analysis
   * will be saved to this location. Used for providing visual context
   * in accessibility reports.
   * 
   * @example "/path/to/screenshots" or "./scan-evidence"
   */
  clipDir?: string;
}
