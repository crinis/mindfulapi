import { IsString, IsUrl } from 'class-validator';
import { Language } from '../types/language.types';

/**
 * Data Transfer Object for creating new accessibility scans.
 * 
 * This DTO defines the required parameters for initiating a new accessibility
 * scan through the REST API. It includes validation rules to ensure scan
 * requests contain valid URLs and language preferences.
 * 
 * The DTO supports various URL protocols including HTTP, HTTPS, and file URLs
 * for development and testing scenarios. TLD requirement is disabled to
 * accommodate localhost and internal network scanning.
 */
export class CreateScanDto {
  /**
   * Target URL to scan for accessibility issues.
   * 
   * Supports HTTP, HTTPS, and file protocols with flexible TLD requirements
   * to accommodate localhost, development servers, and internal network URLs.
   * The URL will be validated for proper format before scan processing begins.
   * 
   * @example "https://example.com"
   * @example "http://localhost:3000"
   * @example "file:///path/to/local/file.html"
   */
  @IsUrl({ require_tld: false, protocols: ['http', 'https', 'file'] })
  url: string;

  /**
   * Language preference for accessibility rule descriptions and help content.
   * 
   * Determines the language used for issue descriptions and help URLs in
   * the scan results. Currently supports standard language codes with
   * 'en' (English) as the default language.
   * 
   * @example "en" for English
   * @example "es" for Spanish
   */
  @IsString()
  language: Language;
}
