/**
 * Identifiers for the optional LLM-agent audit skills.
 *
 * Each skill is a single, narrowly-scoped audit task that runs in addition to
 * axe-core and only judges what deterministic tooling cannot. New skills (e.g.
 * `landmark_usage`) append additional values here.
 */
export enum AgentSkill {
  /**
   * Evaluates the quality of an image's accessible name (alt / aria-label /
   * title / figcaption) for images that already have one. Missing alt text is
   * left to axe-core and intentionally not re-checked here.
   */
  IMAGE_ALT_TEXT = 'image_alt_text',
  /**
   * Judges heading semantics that axe cannot: descriptive/meaningful text
   * (WCAG 2.4.6), unheaded content sections (2.4.10, the AAA heading criterion),
   * and headings faked with styled `<p>`/`<div>` (1.3.1). Structural checks
   * (skipped levels, empty headings, missing `<h1>`) are left to axe-core.
   */
  HEADING_STRUCTURE = 'heading_structure',
  /**
   * Judges whether a link's accessible name conveys its purpose: generic filler
   * ("read more", "click here"), non-descriptive text, or a raw URL as the name
   * (WCAG 2.4.4, Level A), and names that only make sense with their surrounding
   * context (2.4.9, Level AAA). Missing names and identical names pointing to
   * different destinations are left to axe-core.
   */
  LINK_PURPOSE = 'link_purpose',
}
