import type { Page } from 'playwright';
import { AgentSkill } from '../../enums/agent-skill.enum';
import { IssueImpact } from '../../enums/issue-impact.enum';
import type { ScannedIssue } from '../../services/axe-accessibility-scanner.service';
import type {
  AgentHarnessService,
  TokenUsage,
} from '../harness/agent-harness.service';

/**
 * Minimal evidence a skill extracts from a live page. Concrete skills extend
 * this with their own fields (e.g. image attributes + screenshot).
 */
export interface Evidence {
  /** Canonical URL of the page the evidence came from. */
  pageUrl: string;
  /** CSS selector of the element (undefined for page-level evidence). */
  selector?: string;
}

/**
 * Context passed to {@link AuditSkill.collect}. Carries the page's axe findings
 * so skills can dedupe against what deterministic tooling already reports, plus
 * the remaining unit budget and image caps.
 */
export interface CollectContext {
  pageUrl: string;
  /** Axe issues found on this page (deterministic dedupe input). */
  axeIssues: ScannedIssue[];
  /** Units still allowed for this scan across all skills. */
  remainingUnits: number;
  /** Max units to collect on a single page. */
  maxUnitsPerPage: number;
  /** Screenshots larger than this many bytes are dropped. */
  maxImageBytes: number;
}

/**
 * A skill's structured result for one work unit, before persistence. The runner
 * stamps `model` and turns this into an `AgentFinding` row.
 */
export interface AgentFindingDraft {
  skill: AgentSkill;
  pageUrl?: string;
  selector?: string;
  /** Fixed per-skill verdict category. */
  category: string;
  severity: IssueImpact;
  confidence: number;
  message: string;
  suggestion?: string;
  details?: Record<string, unknown> | null;
  /** Token usage for budget accounting. */
  usage: TokenUsage;
}

/**
 * A single, narrowly-scoped audit task.
 *
 * `collect` runs on the live page (deterministic, no LLM) and already applies
 * the axe-aware trigger, so it only returns units that genuinely need a model.
 * `evaluate` issues exactly one structured request per unit. The runner fans
 * `evaluate` out with a concurrency cap.
 */
export interface AuditSkill<E extends Evidence = Evidence> {
  /** Stable identifier, also the client-selectable value. */
  readonly id: AgentSkill;
  /** Whether a unit is one element or the whole page. */
  readonly granularity: 'element' | 'page';
  /** Relative execution order across skills (ascending). */
  readonly order: number;

  /** Extract + trigger-filter work units from a live page. */
  collect(page: Page, ctx: CollectContext): Promise<E[]>;

  /** Judge one work unit with a single structured request. */
  evaluate(
    evidence: E,
    harness: AgentHarnessService,
  ): Promise<AgentFindingDraft | null>;
}
