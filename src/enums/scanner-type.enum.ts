/**
 * Enumeration of available accessibility scanner types.
 * 
 * Defines the different accessibility testing engines that can be used
 * for scanning web pages. Each scanner type has different strengths
 * and may produce different results based on their rule sets.
 */
export enum ScannerType {
  /** HTML_CodeSniffer accessibility scanner (default) */
  HTMLCS = 'htmlcs',
  
  /** Axe accessibility scanner */
  AXE = 'axe',
}

/** Default scanner type used when none is specified */
export const DEFAULT_SCANNER_TYPE = ScannerType.HTMLCS;
