import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ScanStatus } from '../enums/scan-status.enum';
import { Issue } from './issue.entity';
import { Language, DEFAULT_LANGUAGE } from '../types/language.types';

/**
 * Database entity representing an accessibility scan and its metadata.
 * 
 * This entity serves as the root aggregate for accessibility scan operations,
 * containing scan configuration, status tracking, and relationships to
 * discovered accessibility issues. Each scan represents a single analysis
 * of a specific URL at a point in time.
 * 
 * The entity supports the complete scan lifecycle from creation through
 * processing to completion, with automatic timestamp tracking and
 * cascading operations for related issues.
 */
@Entity('scans')
export class Scan {
  /** Unique identifier for the scan, auto-generated primary key */
  @PrimaryGeneratedColumn()
  id: number;

  /** Target URL that was or will be scanned for accessibility issues */
  @Column()
  url: string;

  /** 
   * Language preference for accessibility rule descriptions and help content.
   * Defaults to English ('en') if not specified during scan creation.
   */
  @Column({
    type: 'varchar',
    default: DEFAULT_LANGUAGE,
  })
  language: Language;

  /**
   * CSS selector defining the root element for accessibility scanning scope.
   * 
   * When specified, accessibility analysis focuses only on the specified
   * element and its descendants rather than the entire page. This enables
   * targeted testing of specific page components or sections.
   * 
   * If not specified, the entire page will be scanned.
   */
  @Column({
    type: 'varchar',
    nullable: true,
  })
  rootElement?: string;

  /**
   * Current processing status of the accessibility scan.
   * Tracks progression from PENDING through RUNNING to COMPLETED or FAILED.
   * Enables real-time status monitoring and result availability indication.
   */
  @Column({
    type: 'varchar',
    enum: ScanStatus,
    default: ScanStatus.PENDING,
  })
  status: ScanStatus;

  /**
   * Collection of accessibility issues identified during the scan.
   * Includes WCAG violations, warnings, and notices with detailed
   * context information and visual screenshots when available.
   * Cascade operations ensure issues are managed with their parent scan.
   */
  @OneToMany(() => Issue, (issue) => issue.scan, { cascade: true })
  issues: Issue[];

  /** Timestamp when the scan was initially created */
  @CreateDateColumn()
  createdAt: Date;

  /** Timestamp when the scan was last modified (status updates, etc.) */
  @UpdateDateColumn()
  updatedAt: Date;
}
