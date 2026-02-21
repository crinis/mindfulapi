import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ScanStatus } from '../enums/scan-status.enum';
import { ScanMode } from '../enums/scan-mode.enum';
import { Issue } from './issue.entity';

/**
 * Database entity representing an accessibility scan and its metadata.
 */
@Entity('scans')
export class Scan {
  /** Primary key for the scan run. */
  @PrimaryGeneratedColumn()
  id: number;

  /**
   * Legacy-friendly primary target URL used for filtering and quick display.
   * For single URL mode this matches the only entry in `targets`.
   */
  @Column()
  url: string;

  /**
   * How this run resolves the set of pages to analyze.
   */
  @Column({
    type: 'varchar',
    enum: ScanMode,
    default: ScanMode.SINGLE_URL,
  })
  mode: ScanMode;

  /**
   * Input URLs for this run.
   * - single_url: one URL
   * - url_list: explicit list
   * - crawl: seed URLs
   */
  @Column({ type: 'simple-json', nullable: true })
  targets?: string[];

  /**
   * CSS selector defining the root element scope for scanning.
   * When null, the entire page is scanned.
   */
  @Column({ type: 'varchar', nullable: true })
  rootElement?: string;

  /**
   * Optional subset of axe rule IDs to execute.
   * Null means all rules are enabled.
   */
  @Column({ type: 'simple-json', nullable: true })
  ruleIds?: string[] | null;

  /** Crawl page limit (only applies to crawl mode). */
  @Column({ type: 'integer', nullable: true })
  crawlMaxPages?: number | null;

  /** Crawl depth limit (only applies to crawl mode). */
  @Column({ type: 'integer', nullable: true })
  crawlMaxDepth?: number | null;

  /**
   * Restrict crawl discovery to the host(s) of seed URLs.
   * Null when crawl mode is not used.
   */
  @Column({ type: 'boolean', nullable: true })
  crawlSameHostOnly?: boolean | null;

  /**
   * Optional regex patterns of URLs to include while crawling.
   */
  @Column({ type: 'simple-json', nullable: true })
  crawlIncludePatterns?: string[] | null;

  /**
   * Optional regex patterns of URLs to exclude while crawling.
   */
  @Column({ type: 'simple-json', nullable: true })
  crawlExcludePatterns?: string[] | null;

  /** Number of pages analyzed concurrently while crawling. */
  @Column({ type: 'integer', nullable: true })
  crawlConcurrency?: number | null;

  /** Current lifecycle status of this run. */
  @Column({
    type: 'varchar',
    enum: ScanStatus,
    default: ScanStatus.PENDING,
  })
  status: ScanStatus;

  /** Number of distinct pages discovered during this run. */
  @Column({ type: 'integer', default: 0 })
  pagesDiscovered: number;

  /** Number of pages successfully analyzed. */
  @Column({ type: 'integer', default: 0 })
  pagesScanned: number;

  /** Number of pages that failed during analysis. */
  @Column({ type: 'integer', default: 0 })
  pagesFailed: number;

  /** Related issue occurrences found during the scan run. */
  @OneToMany(() => Issue, (issue) => issue.scan, { cascade: true })
  issues: Issue[];

  /** Timestamp when the scan run was created. */
  @CreateDateColumn()
  createdAt: Date;

  /** Timestamp when the scan run was last updated. */
  @UpdateDateColumn()
  updatedAt: Date;
}
