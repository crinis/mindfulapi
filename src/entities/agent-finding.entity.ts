import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { Scan } from './scan.entity';
import { AgentSkill } from '../enums/agent-skill.enum';
import { IssueImpact } from '../enums/issue-impact.enum';

/**
 * A single finding produced by an LLM-agent audit skill.
 *
 * Stored one-row-per-finding (mirroring {@link Issue}) so grouped-count
 * queries stay uniform. These findings complement — never duplicate —
 * axe-core issues: skills only evaluate what deterministic tooling cannot.
 */
@Entity('agent_findings')
export class AgentFinding {
  /** Primary key for the persisted finding. */
  @PrimaryGeneratedColumn()
  id: number;

  /** Parent scan; cascade delete removes findings when the scan is deleted. */
  @Index()
  @ManyToOne(() => Scan, (scan) => scan.agentFindings, { onDelete: 'CASCADE' })
  scan: Scan;

  /** Skill that produced this finding. */
  @Index()
  @Column({ type: 'varchar' })
  skill: AgentSkill;

  /** Canonical URL of the page the finding relates to. */
  @Index()
  @Column({ nullable: true })
  pageUrl?: string;

  /** CSS selector for the evaluated element (null for page-level findings). */
  @Column({ nullable: true })
  selector?: string;

  /** Fixed per-skill verdict category (e.g. `alt_redundant`). */
  @Index()
  @Column({ type: 'varchar' })
  category: string;

  /** Severity, reusing the axe impact scale for a consistent client view. */
  @Column({ type: 'text' })
  severity: IssueImpact;

  /** Model-reported confidence in the verdict, 0–1. */
  @Column({ type: 'float', default: 0 })
  confidence: number;

  /** Human-readable summary of the finding. */
  @Column({ type: 'text' })
  message: string;

  /** Optional concrete remediation suggestion (e.g. proposed alt text). */
  @Column({ type: 'text', nullable: true })
  suggestion?: string;

  /** Skill-specific structured payload for richer client rendering. */
  @Column({ type: 'simple-json', nullable: true })
  details?: Record<string, unknown> | null;

  /** Provenance: the model identifier that produced this finding. */
  @Column({ nullable: true })
  model?: string;

  /** Input (prompt) tokens spent producing this finding. */
  @Column({ type: 'integer', default: 0 })
  inputTokens: number;

  /** Output (completion) tokens spent producing this finding. */
  @Column({ type: 'integer', default: 0 })
  outputTokens: number;

  /** Timestamp when the finding was persisted. */
  @CreateDateColumn()
  createdAt: Date;
}
