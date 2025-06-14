import { Issue as KayleIssue } from 'kayle';

/**
 * Interface for rule services that provide help URLs for accessibility rules.
 * 
 * Different accessibility scanners may provide help URLs in different ways,
 * so this interface allows for scanner-specific implementations of URL generation.
 */
export interface IRuleService {
  /**
   * Generates help URLs for an accessibility rule.
   * 
   * @param ruleId - The accessibility rule identifier
   * @param kayleIssue - Optional Kayle issue for scanner-specific URL extraction
   * @returns Array of help URLs for the rule
   */
  getHelpUrls(ruleId: string, kayleIssue?: KayleIssue): string[];
}
