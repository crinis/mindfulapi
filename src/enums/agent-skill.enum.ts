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
}
