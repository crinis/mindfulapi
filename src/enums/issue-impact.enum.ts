/**
 * Enumeration of accessibility issue severity levels based on WCAG standards.
 * 
 * This enum categorizes accessibility issues by their impact on user experience
 * and compliance requirements, following HTML_CodeSniffer and WCAG conventions.
 * The severity levels help prioritize remediation efforts and understand
 * compliance implications.
 */
export enum IssueImpact {
  /** 
   * Critical accessibility violations that prevent user access.
   * 
   * These issues fail WCAG conformance requirements and must be fixed
   * to ensure accessibility compliance. Examples include missing alt text
   * for images, insufficient color contrast, or keyboard navigation barriers.
   */
  ERROR = 'error',
  
  /** 
   * Potential accessibility issues requiring manual review.
   * 
   * These items may indicate accessibility problems but require human
   * judgment to determine if they're actual violations. Examples include
   * suspicious heading structures or elements that might confuse assistive technology.
   */
  WARNING = 'warning',
  
  /** 
   * Accessibility best practice recommendations.
   * 
   * These suggestions can improve the user experience but don't necessarily
   * violate WCAG standards. Examples include adding supplementary descriptions
   * or optimizing content structure for better accessibility.
   */
  NOTICE = 'notice',
}
