import { Injectable } from '@nestjs/common';
import { Issue as KayleIssue } from 'kayle';
import { IRuleService } from '../interfaces/rule-service.interface';

/**
 * HTMLCS-specific rule service for generating WCAG technique help URLs.
 * 
 * This service provides algorithmic generation of WCAG technique documentation URLs
 * based on HTMLCS accessibility rule identifiers. Rather than maintaining static mappings,
 * it intelligently parses rule IDs to extract technique identifiers and constructs
 * appropriate documentation URLs for each technique type.
 * 
 * Key features:
 * - Algorithmic URL generation for WCAG 2.1 techniques without static data files
 * - Support for multiple rule ID formats (simple, dot-separated, WCAG Principle-based)
 * - Technique categorization (General, HTML, ARIA, CSS, Failures, etc.)
 * - Robust rule ID normalization and parsing
 * - Fallback URL provision when specific techniques cannot be identified
 * 
 * Supported technique types:
 * - G: General techniques
 * - H: HTML techniques  
 * - ARIA: ARIA techniques
 * - C: CSS techniques
 * - SCR: Client-side scripting techniques
 * - F: Failure techniques
 * - T: Text techniques
 * - SM: SMIL techniques
 * - SL: Silverlight techniques
 * 
 * The service handles complex rule ID formats including WCAG Principle-based rules
 * with multiple technique identifiers and nested sub-rule structures.
 */
@Injectable()
export class HtmlcsRuleService implements IRuleService {
  constructor() {
    // No initialization needed - service is now purely algorithmic
  }

  /**
   * Normalizes accessibility rule IDs to a consistent internal format.
   * 
   * This method handles the variety of rule ID formats that can be generated by
   * different accessibility scanners and tools. It performs format standardization
   * to enable consistent processing and URL generation across the application.
   * 
   * Normalization includes:
   * - WCAG prefix removal (WCAG2A, WCAG2AA, WCAG2AAA)
   * - WCAG Principle rule format conversion for technique extraction
   * - Dot-to-underscore conversion for technique separators in complex rules
   * - Preservation of simple rule formats that don't require transformation
   * 
   * Examples of handled formats:
   * - WCAG2AA.Principle1.Guideline1_1.1_1_1.G73,G74 → Principle1.Guideline1_1.1_1_1_G73,G74
   * - WCAG2AA.Principle4.Guideline4_1.4_1_2.H91.A.NoContent → Principle4.Guideline4_1.4_1_2_H91.A.NoContent
   * - Simple rules like AltVersion, Applet.MissingAlt remain unchanged
   * 
   * @param ruleId - Original rule ID from accessibility scanner
   * @returns Normalized rule ID suitable for technique extraction
   */
  private normalizeRuleId(ruleId: string): string {
    // Remove WCAG2A, WCAG2AA, or WCAG2AAA prefix if present
    let normalized = ruleId.replace(/^WCAG2A{1,3}\./, '');

    // Handle WCAG Principle-based rules only
    if (normalized.startsWith('Principle')) {
      // For Principle rules, we need to convert the first dot before technique identifiers to underscore
      // Examples to handle:
      // - Principle1.Guideline1_1.1_1_1.G73,G74 -> Principle1.Guideline1_1.1_1_1_G73,G74
      // - Principle2.Guideline2_4.2_4_1.G1,G123,G124.NoSuchID -> Principle2.Guideline2_4.2_4_1_G1,G123,G124.NoSuchID
      // - Principle1.Guideline1_3.1_3_1.F68.HiddenAttr -> Principle1.Guideline1_3.1_3_1_F68.HiddenAttr
      // - Principle4.Guideline4_1.4_1_2.H91.A.NoContent -> Principle4.Guideline4_1.4_1_2_H91.A.NoContent

      // Match the guideline part and the technique part
      // Guideline format: Principle{N}.Guideline{N}_{N}.{N}_{N}_{N}
      // Then comes a dot and technique identifiers starting with capital letters and numbers
      const match = normalized.match(
        /^(Principle\d+\.Guideline\d+_\d+\.\d+_\d+_\d+)\.([A-Z]+.*)$/,
      );
      if (match) {
        const guidelinePart = match[1]; // e.g., "Principle2.Guideline2_4.2_4_1"
        const techniquePart = match[2]; // e.g., "G1,G123,G124.NoSuchID" or "H91.A.NoContent"
        normalized = guidelinePart + '_' + techniquePart;
      }
    }

    // For non-Principle rules (simple rules, dot-separated rules), return as-is
    // Examples: AltVersion, Applet.MissingAlt, Area.GeneralAlt - these don't need transformation

    return normalized;
  }

  /**
   * Generates comprehensive help URLs for accessibility rule remediation.
   * 
   * This method provides developers with direct links to WCAG technique documentation
   * for understanding and fixing accessibility issues. It analyzes rule IDs to extract
   * relevant technique identifiers and constructs appropriate documentation URLs.
   * 
   * The method ensures that every rule has at least one help URL available, providing
   * a fallback to general WCAG techniques when specific technique extraction fails.
   * This guarantees that developers always have access to remediation guidance.
   * 
   * URL generation is purely algorithmic, eliminating the need for static mapping
   * files while supporting the full range of WCAG technique categories.
   * 
   * @param ruleId - Accessibility rule identifier from scanner results
   * @returns Array of help URLs for rule remediation, always contains at least one URL
   */
  getHelpUrls(ruleId: string, kayleIssue?: KayleIssue): string[] {
    // Generate URLs purely from rule ID analysis
    const generatedUrls = this.generateHelpUrlsFromRuleId(ruleId);

    // If no URLs could be generated, provide a simple fallback
    if (generatedUrls.length === 0) {
      return ['https://www.w3.org/WAI/WCAG21/Techniques/'];
    }

    return generatedUrls;
  }

  /**
   * Generates help URLs by extracting and processing technique identifiers from rule IDs.
   * 
   * This method implements the core logic for URL generation by analyzing different
   * rule ID patterns and extracting the embedded technique identifiers. It handles
   * both simple rules and complex WCAG Principle-based rules with multiple techniques.
   * 
   * Processing approach:
   * - WCAG Principle rules: Extract techniques from structured guideline format
   * - Simple rules: Extract technique identifiers from rule prefixes
   * - Multiple techniques: Handle comma-separated and nested technique lists
   * - URL generation: Route each technique to appropriate documentation category
   * 
   * @param ruleId - Rule identifier to analyze for technique extraction
   * @returns Array of generated help URLs for identified techniques
   */
  private generateHelpUrlsFromRuleId(ruleId: string): string[] {
    const urls: string[] = [];

    // Remove WCAG prefix for processing
    const normalizedId = ruleId.replace(/^WCAG2A{1,3}\./, '');

    if (normalizedId.startsWith('Principle')) {
      // Extract techniques from WCAG Principle rules
      // Examples:
      // - Principle1.Guideline1_1.1_1_1.G73,G74
      // - Principle1.Guideline1_1.1_1_1.H2.EG3
      // - Principle1.Guideline1_1.1_1_1.H53,ARIA6

      const techniques = this.extractTechniquesFromPrincipleRule(normalizedId);
      for (const technique of techniques) {
        const url = this.generateUrlForTechnique(technique);
        if (url) {
          urls.push(url);
        }
      }
    } else {
      // For Section508 and other rules, extract technique identifiers
      // Examples: H49.AlignAttr -> H49
      const techniques = this.extractTechniquesFromSimpleRule(normalizedId);
      for (const technique of techniques) {
        const url = this.generateUrlForTechnique(technique);
        if (url) {
          urls.push(url);
        }
      }
    }

    return urls;
  }

  /**
   * Extracts technique identifiers from WCAG Principle-based rule IDs
   * @param ruleId - Normalized rule ID starting with "Principle"
   * @returns Array of technique identifiers (e.g., ["G73", "G74", "H2"])
   */
  private extractTechniquesFromPrincipleRule(ruleId: string): string[] {
    const techniques: string[] = [];

    // Match pattern: Principle{N}.Guideline{N}_{N}.{N}_{N}_{N}.{techniques}
    const match = ruleId.match(
      /^Principle\d+\.Guideline\d+_\d+\.\d+_\d+_\d+\.(.+)$/,
    );
    if (match) {
      const techniquesPart = match[1];

      // Split by comma first (for cases like "G73,G74")
      const commaSeparated = techniquesPart.split(',');

      for (const part of commaSeparated) {
        // Extract technique identifiers using regex
        // Matches: G73, H2, ARIA6, F68, etc.
        const techniqueMatches = part.match(/([A-Z]+\d*)/g);
        if (techniqueMatches) {
          techniques.push(...techniqueMatches);
        }
      }
    }

    return [...new Set(techniques)]; // Remove duplicates
  }

  /**
   * Extracts technique identifiers from simple rule IDs
   * @param ruleId - Simple rule ID (e.g., "H49.AlignAttr")
   * @returns Array of technique identifiers
   */
  private extractTechniquesFromSimpleRule(ruleId: string): string[] {
    const techniques: string[] = [];

    // Extract technique from the beginning of the rule ID
    const match = ruleId.match(/^([A-Z]+\d+)/);
    if (match) {
      techniques.push(match[1]);
    }

    return techniques;
  }

  /**
   * Generates a WCAG technique URL for a given technique identifier
   * @param technique - Technique identifier (e.g., "G73", "H2", "ARIA6")
   * @returns Generated URL or null if technique format is not recognized
   */
  private generateUrlForTechnique(technique: string): string | null {
    const baseUrl = 'https://www.w3.org/WAI/WCAG21/Techniques';

    if (technique.startsWith('G')) {
      // General techniques
      return `${baseUrl}/general/${technique}`;
    } else if (technique.startsWith('H')) {
      // HTML techniques
      return `${baseUrl}/html/${technique}`;
    } else if (technique.startsWith('ARIA')) {
      // ARIA techniques
      return `${baseUrl}/aria/${technique}`;
    } else if (technique.startsWith('C')) {
      // CSS techniques
      return `${baseUrl}/css/${technique}`;
    } else if (technique.startsWith('SCR')) {
      // Client-side scripting techniques
      return `${baseUrl}/client-side-script/${technique}`;
    } else if (technique.startsWith('F')) {
      // Failure techniques
      return `${baseUrl}/failures/${technique}`;
    } else if (technique.startsWith('T')) {
      // Text techniques
      return `${baseUrl}/text/${technique}`;
    } else if (technique.startsWith('SM')) {
      // SMIL techniques
      return `${baseUrl}/smil/${technique}`;
    } else if (technique.startsWith('SL')) {
      // Silverlight techniques
      return `${baseUrl}/silverlight/${technique}`;
    }

    // If technique format is not recognized, return null
    return null;
  }
}
