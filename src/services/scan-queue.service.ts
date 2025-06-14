import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Language } from '../types/language.types';
import { ScannerType } from '../enums/scanner-type.enum';

/**
 * Data structure for scan processing jobs in the BullMQ queue.
 * 
 * Contains all necessary information for the scan processor to execute
 * accessibility scans asynchronously in the background.
 */
export interface ScanJobData {
  /** Unique identifier of the scan entity to process */
  scanId: number;
  /** Target URL to scan for accessibility issues */
  url: string;
  /** Language preference for accessibility rule descriptions */
  language: Language;
  /** CSS selector defining the root element scope for scanning */
  rootElement?: string;
  /** Accessibility scanner type to use for the scan */
  scannerType?: ScannerType;
}

/**
 * Service for managing accessibility scan job queuing with BullMQ.
 * 
 * This service provides an abstraction layer over BullMQ for managing the
 * asynchronous processing of accessibility scans. It handles job scheduling,
 * queue monitoring, and provides insights into processing status.
 * 
 * Key features:
 * - Asynchronous scan job queuing with configurable delays
 * - Queue status monitoring for administrative dashboards
 * - Integration with BullMQ's retry and error handling mechanisms
 * - Job data structure enforcement through TypeScript interfaces
 * 
 * The service uses a small delay when adding jobs to ensure database
 * transactions are committed before background processing begins, preventing
 * race conditions between scan creation and processing.
 */
@Injectable()
export class ScanQueueService {
  constructor(
    @InjectQueue('scan-processing') private scanQueue: Queue<ScanJobData>,
  ) {}

  /**
   * Adds a new accessibility scan job to the processing queue.
   * 
   * This method queues scan jobs for asynchronous background processing,
   * allowing the API to respond immediately while scans execute in parallel.
   * A small delay is applied to ensure the database transaction creating the
   * scan entity is fully committed before processing begins.
   * 
   * The job will be picked up by the ScanProcessor service which handles the
   * complete scan execution workflow including browser automation, accessibility
   * analysis, and result persistence.
   * 
   * @param scanId - Unique identifier of the scan entity to process
   * @param url - Target URL for accessibility scanning
   * @param language - Language preference for accessibility rule descriptions
   * @param rootElement - CSS selector defining the root element scope for scanning
   * @param scannerType - Accessibility scanner type to use for the scan
   */
  async addScanJob(
    scanId: number,
    url: string,
    language: Language,
    rootElement?: string,
    scannerType?: ScannerType,
  ): Promise<void> {
    await this.scanQueue.add(
      'process-scan',
      {
        scanId,
        url,
        language,
        rootElement,
        scannerType: scannerType || ScannerType.HTMLCS,
      },
      {
        delay: 1000, // Small delay to ensure database transaction is committed
      },
    );
  }

  /**
   * Retrieves current queue status and job counts for monitoring purposes.
   * 
   * This method provides real-time insights into the queue processing state,
   * useful for administrative dashboards, system monitoring, and troubleshooting.
   * Job counts include all major queue states to give a complete picture of
   * processing activity.
   * 
   * @returns Object containing counts for waiting, active, completed, and failed jobs
   */
  async getQueueStatus() {
    const waiting = await this.scanQueue.getWaiting();
    const active = await this.scanQueue.getActive();
    const completed = await this.scanQueue.getCompleted();
    const failed = await this.scanQueue.getFailed();

    return {
      waiting: waiting.length,
      active: active.length,
      completed: completed.length,
      failed: failed.length,
    };
  }
}
