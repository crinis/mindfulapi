import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from 'typeorm';
import { Scan } from './scan.entity';
import { IssueImpact } from '../enums/issue-impact.enum';

/**
 * Database entity representing an individual accessibility issue discovered during scanning.
 * 
 * This entity captures detailed information about specific accessibility violations,
 * warnings, or notices identified by HTML_CodeSniffer analysis. Each issue is
 * associated with a parent scan and contains comprehensive context for developers
 * to understand and remediate the accessibility problem.
 * 
 * Issues include technical details like CSS selectors for precise element location,
 * contextual HTML snippets for understanding the problem area, and optional
 * screenshots for visual reference during remediation.
 */
@Entity('issues')
export class Issue {
  /** Unique identifier for the accessibility issue */
  @PrimaryGeneratedColumn()
  id: number;

  /**
   * Parent scan that identified this accessibility issue.
   * Cascade delete ensures issues are removed when parent scan is deleted.
   */
  @ManyToOne(() => Scan, (scan) => scan.issues, { onDelete: 'CASCADE' })
  scan: Scan;

  /**
   * Accessibility rule identifier from HTML_CodeSniffer that triggered this issue.
   * Used for generating help URLs and grouping related violations.
   * Examples: "WCAG2AA.Principle1.Guideline1_1.1_1_1.H37", "H49.AlignAttr"
   */
  @Column()
  ruleId: string;

  /**
   * Human-readable description of the accessibility rule violation.
   * Provides context about what accessibility requirement was not met
   * and guidance for developers on the nature of the problem.
   */
  @Column()
  description: string;

  /**
   * Severity level of the accessibility issue for prioritization.
   * ERROR: Must fix - prevents accessibility (WCAG violations)
   * WARNING: Should investigate - potential accessibility barrier
   * NOTICE: Consider addressing - accessibility best practice
   */
  @Column({ type: 'text' })
  impact: IssueImpact;

  /**
   * CSS selector identifying the specific DOM element with the accessibility issue.
   * Enables developers to locate the exact element that needs remediation.
   * May be null for page-level issues that don't target specific elements.
   */
  @Column({ nullable: true })
  selector?: string;

  /**
   * HTML context snippet showing the problematic element and its surroundings.
   * Provides additional context for understanding the issue within its DOM structure.
   * Helps developers identify the specific markup that triggered the violation.
   */
  @Column({ nullable: true })
  context?: string;

  /**
   * Filename of screenshot image captured for this specific accessibility issue.
   * Provides visual context showing how the issue appears to users.
   * Screenshot files are stored in the configured screenshot directory.
   */
  @Column({ nullable: true })
  screenshotFilename?: string;
}
