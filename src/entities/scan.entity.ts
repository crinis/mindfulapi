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

/**
 * Database entity representing an accessibility scan and its metadata.
 */
@Entity('scans')
export class Scan {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  url: string;

  /**
   * CSS selector defining the root element scope for scanning.
   * When null, the entire page is scanned.
   */
  @Column({ type: 'varchar', nullable: true })
  rootElement?: string;

  @Column({
    type: 'varchar',
    enum: ScanStatus,
    default: ScanStatus.PENDING,
  })
  status: ScanStatus;

  @OneToMany(() => Issue, (issue) => issue.scan, { cascade: true })
  issues: Issue[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
