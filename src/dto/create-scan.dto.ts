import { IsString, IsUrl, IsOptional, IsEnum, IsArray } from 'class-validator';
import { Language } from '../types/language.types';
import { ScannerType } from '../enums/scanner-type.enum';

/**
 * Data Transfer Object for creating new accessibility scans.
 * 
 * This DTO defines the required parameters for initiating a new accessibility
 * scan through the REST API. It includes validation rules to ensure scan
 * requests contain valid URLs and language preferences.
 * 
 * The DTO supports HTTP and HTTPS protocols with flexible TLD requirements
 * to accommodate localhost and internal network scanning.
 */
export class CreateScanDto {
  /**
   * Target URL to scan for accessibility issues.
   * 
   * Supports HTTP and HTTPS protocols with flexible TLD requirements
   * to accommodate localhost, development servers, and internal network URLs.
   * The URL will be validated for proper format before scan processing begins.
   * 
   * @example "https://example.com"
   * @example "http://localhost:3000"
   */
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  url: string;

  /**
   * Language preference for accessibility rule descriptions and help content.
   * 
   * Determines the language used for issue descriptions and help URLs in
   * the scan results. Currently supports standard language codes with
   * 'en' (English) as the default language when not specified.
   * 
   * @example "en" for English (default)
   * @example "es" for Spanish
   */
  @IsOptional()
  @IsString()
  language?: Language;

  /**
   * CSS selector to limit scanning scope to a specific page element.
   * 
   * When provided, accessibility analysis will focus only on the specified
   * element and its descendants. This can be useful for testing specific
   * components or sections of a page. If not specified, the entire page
   * will be scanned.
   * 
   * @example "main" to scan only the main content area
   * @example "#content" to scan only the element with id="content"
   * @example ".article" to scan only elements with class="article"
   */
  @IsOptional()
  @IsString()
  rootElement?: string;

  /**
   * Accessibility scanner type to use for the scan.
   * 
   * Determines which accessibility testing engine will be used to analyze
   * the page. Different scanners may have different rule sets and provide
   * different types of help information.
   * 
   * @example "htmlcs" for HTML_CodeSniffer (default)
   * @example "axe" for Axe accessibility scanner
   */
  @IsOptional()
  @IsEnum(ScannerType)
  scannerType?: ScannerType;

  /**
   * Specific accessibility rule IDs to execute during scanning.
   * 
   * When provided, only the specified rules will be run and their results
   * stored in the database. This allows targeted accessibility testing for
   * specific requirements or compliance checks. If not specified, all
   * available rules for the scanner will be executed.
   * 
   * Rule IDs must match the format expected by the selected scanner:
   * - HTMLCS: "WCAG2AA.Principle1.Guideline1_1.1_1_1.H37"
   * - Axe: "color-contrast", "alt-text", etc.
   * 
   * @example ["color-contrast", "alt-text"] for Axe scanner
   * @example ["WCAG2AA.Principle1.Guideline1_1.1_1_1.H37"] for HTMLCS scanner
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  ruleIds?: string[];
}
