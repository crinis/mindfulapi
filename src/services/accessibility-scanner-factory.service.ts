import { Injectable } from '@nestjs/common';
import { IAccessibilityScanner } from '../interfaces';
import { HtmlcsAccessibilityScanner } from './htmlcs-accessibility-scanner.service';
import { AxeAccessibilityScanner } from './axe-accessibility-scanner.service';
import { ScannerType, DEFAULT_SCANNER_TYPE } from '../enums/scanner-type.enum';

/**
 * Factory service for creating accessibility scanner instances.
 * 
 * This service provides a centralized way to obtain different types of
 * accessibility scanners based on the requested scanner type. It handles
 * the instantiation and configuration of scanner implementations.
 * 
 * Supported scanner types:
 * - HTMLCS: HTML_CodeSniffer accessibility scanner
 * - AXE: Axe accessibility scanner
 */
@Injectable()
export class AccessibilityScannerFactory {
  constructor(
    private readonly htmlcsScanner: HtmlcsAccessibilityScanner,
    private readonly axeScanner: AxeAccessibilityScanner,
  ) {}

  /**
   * Creates an accessibility scanner instance based on the specified type.
   * 
   * @param scannerType - The type of scanner to create (defaults to HTMLCS)
   * @returns The requested accessibility scanner implementation
   * @throws {Error} When an unsupported scanner type is requested
   */
  getScanner(scannerType: ScannerType = DEFAULT_SCANNER_TYPE): IAccessibilityScanner {
    switch (scannerType) {
      case ScannerType.HTMLCS:
        return this.htmlcsScanner;
      case ScannerType.AXE:
        return this.axeScanner;
      default:
        throw new Error(`Unsupported scanner type: ${scannerType}`);
    }
  }

  /**
   * Gets all available scanner types.
   * 
   * @returns Array of all supported scanner types
   */
  getAvailableTypes(): ScannerType[] {
    return Object.values(ScannerType);
  }
}
