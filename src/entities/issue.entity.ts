import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  Index,
} from 'typeorm';
import { Scan } from './scan.entity';
import { IssueImpact } from '../enums/issue-impact.enum';

/**
 * Database entity representing an individual accessibility issue discovered during axe-core scanning.
 */
@Entity('issues')
export class Issue {
  /** Primary key for the persisted issue occurrence. */
  @PrimaryGeneratedColumn()
  id: number;

  /** Parent scan - cascade delete removes issues when scan is deleted. */
  @Index()
  @ManyToOne(() => Scan, (scan) => scan.issues, { onDelete: 'CASCADE' })
  scan: Scan;

  /** Axe rule identifier (e.g. "color-contrast", "image-alt"). */
  @Column()
  ruleId: string;

  /** Human-readable description of the accessibility violation. */
  @Column()
  description: string;

  /** Severity level as reported by axe-core (critical, serious, moderate, minor). */
  @Column({ type: 'text' })
  impact: IssueImpact;

  /** Canonical URL of the page where this issue was found. */
  @Index()
  @Column({ nullable: true })
  pageUrl?: string;

  /** CSS selector identifying the specific DOM element with the issue. */
  @Column({ nullable: true })
  selector?: string;

  /** HTML snippet showing the problematic element. */
  @Column({ nullable: true })
  context?: string;

  /** Help URL from axe-core pointing to remediation guidance. */
  @Column({ nullable: true })
  helpUrl?: string;
}
