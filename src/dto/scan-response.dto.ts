import { ScanStatus } from '../enums/scan-status.enum';
import { IssueImpact } from '../enums/issue-impact.enum';

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
 * Data Transfer Object representing a group of accessibility issues for the same rule.
 * 
 * This DTO organizes accessibility issues by rule type, providing aggregated
 * information about violations of the same accessibility requirement. It includes
 * help URLs for remediation guidance and summarizes all instances of the violation.
 */
export class ViolationResponseDto {
  /** Accessibility rule identifier that triggered these issues */
  ruleId: string;
  
  /** Human-readable description of the accessibility rule violation */
  description: string;
  
  /** Array of help URLs providing remediation guidance for this rule type */
  urls: string[];
  
  /** Severity level for prioritizing remediation efforts */
  impact: IssueImpact;
  
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
