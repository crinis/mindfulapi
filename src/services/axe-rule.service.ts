import { Injectable } from '@nestjs/common';
import { IRuleService } from '../interfaces/rule-service.interface';

/**
 * Axe-specific rule service that generates help URLs for Axe accessibility rules.
 * 
 * This service handles URL generation for Axe accessibility scanner results.
 * Unlike HTML_CodeSniffer which uses WCAG technique URLs, Axe rules use
 * the Deque University documentation pattern.
 * 
 * Axe help URLs follow the pattern: https://dequeuniversity.com/rules/axe/4.4/{ruleId}
 * This provides consistent access to detailed rule documentation and remediation guidance.
 */
@Injectable()
export class AxeRuleService implements IRuleService {
  private static readonly AXE_BASE_URL = 'https://dequeuniversity.com/rules/axe/4.6';

  /**
   * Generates help URLs for Axe accessibility rules.
   * 
   * Axe rules follow a predictable URL pattern on Deque University's documentation site.
   * This method constructs the appropriate help URL for any given Axe rule ID.
   * 
   * @param ruleId - The Axe rule identifier (e.g., "html-has-lang", "landmark-one-main")
   * @returns Array containing the help URL for the specified rule
   */
  getHelpUrls(ruleId: string): string[] {
    if (!ruleId) {
      return [];
    }

    const helpUrl = `${AxeRuleService.AXE_BASE_URL}/${ruleId}`;
    return [helpUrl];
  }
}
