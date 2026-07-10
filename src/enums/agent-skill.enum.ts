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
  /**
   * Judges the clarity of a form control's label and instructions that axe
   * cannot: uninformative or ambiguous labels (WCAG 2.4.6) and fields that need
   * format/constraint guidance the user is never given (3.3.2). Missing / empty
   * / title-only / multiple labels and missing button/select names are left to
   * axe-core; deterministic attribute/structure facts (required state,
   * placeholder-as-label, control grouping, autocomplete tokens) are out of
   * scope by design.
   */
  FORM_LABELS = 'form_labels',
  /**
   * Judges whether the page `<title>` describes its topic or purpose (WCAG
   * 2.4.2, Level A): placeholder/boilerplate titles ("Untitled Document",
   * "Home") or titles that do not convey what the page is about. A missing or
   * empty `<title>` is left to axe-core (`document-title`), and cross-page title
   * uniqueness is out of scope for a page-scoped skill.
   */
  PAGE_TITLE = 'page_title',
}
