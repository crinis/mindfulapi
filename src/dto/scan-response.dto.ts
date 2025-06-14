import { ScanStatus } from '../enums/scan-status.enum';
import { ScannerType } from '../enums/scanner-type.enum';
import { IssueImpact } from '../enums/issue-impact.enum';
import { Language } from '../types/language.types';

/**
 * Data Transfer Object representing an individual accessibility issue for API responses.
 * 
 * This DTO provides essential issue details including element location information
 * and visual context through screenshots. It focuses on the information most
 * useful for developers during remediation efforts.
 */
export class IssueResponseDto {
  /** Unique identifier for the accessibility issue */
  id: number;
  
  /** CSS selector identifying the DOM element with the accessibility issue */
  selector?: string;
  
  /** HTML context snippet showing the problematic element and surroundings */
  context?: string;
  
  /** 
   * Full URL to screenshot image showing visual context of the accessibility issue.
   * Constructed by combining base URL with screenshot filename when available.
   */
  screenshotUrl?: string;
}

/**
 * Data Transfer Object representing accessibility rule information.
 * 
 * This DTO provides essential rule metadata including identification,
 * description, impact level, and remediation guidance URLs.
 */
export class RuleResponseDto {
  /** Accessibility rule identifier (e.g., "WCAG2AA.Principle1.Guideline1_1.1_1_1.H37") */
  id: string;
  
  /** Human-readable description of the accessibility rule violation */
  description: string;
  
  /** Severity level for prioritizing remediation efforts */
  impact: IssueImpact;
  
  /** Array of help URLs providing remediation guidance for this rule type */
  urls: string[];
}

/**
 * Data Transfer Object representing a group of accessibility issues for the same rule.
 * 
 * This DTO organizes accessibility issues by rule type, providing aggregated
 * information about violations of the same accessibility requirement. It includes
 * rule metadata and all issue instances for that rule.
 */
export class ViolationResponseDto {
  /** Accessibility rule information */
  rule: RuleResponseDto;
  
  /** Array of individual issue instances for this rule violation */
  issues: IssueResponseDto[];
  
  /** Total count of issues for this specific accessibility rule */
  issueCount: number;
}

/**
 * Data Transfer Object for comprehensive accessibility scan results in API responses.
 * 
 * This DTO provides complete scan information including metadata, processing status,
 * and structured accessibility violation data. Issues are organized by rule type
 * for easier consumption by client applications and developer tools.
 * 
 * The response structure groups individual issues by accessibility rule, making
 * it easier for developers to understand and prioritize remediation efforts.
 */
export class ScanResponseDto {
  /** Unique identifier for the accessibility scan */
  id: number;
  
  /** Target URL that was scanned for accessibility issues */
  url: string;
  
  /** Language preference for accessibility rule descriptions and help content */
  language: Language;
  
  /** CSS selector defining the root element scope for the accessibility scan. If not specified, the entire page was scanned. */
  rootElement?: string;
  
  /** Accessibility scanner type used for this scan (HTMLCS or AXE) */
  scannerType: ScannerType;
  
  /** Current processing status (PENDING, RUNNING, COMPLETED, or FAILED) */
  status: ScanStatus;
  
  /** Array of accessibility violations organized by rule type */
  violations: ViolationResponseDto[];
  
  /** Total count of all accessibility issues found across all rules */
  totalIssueCount: number;
  
  /** Timestamp when the scan was initially created */
  createdAt: Date;
  
  /** Timestamp when the scan was last updated (status changes, etc.) */
  updatedAt: Date;
}
