/**
 * Accessibility issue severity levels as reported by axe-core.
 */
export enum IssueImpact {
  /** Highest severity with significant accessibility barriers. */
  CRITICAL = 'critical',
  /** High severity requiring prompt remediation. */
  SERIOUS = 'serious',
  /** Medium severity with notable usability impact. */
  MODERATE = 'moderate',
  /** Lowest severity, usually incremental improvements. */
  MINOR = 'minor',
}
