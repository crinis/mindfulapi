import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from 'bullmq';
import { Scan } from '../entities/scan.entity';
import { Issue } from '../entities/issue.entity';
import { ScanStatus } from '../enums/scan-status.enum';
import { ScannerType } from '../enums/scanner-type.enum';
import { ScanJobData } from './scan-queue.service';
import { BrowserService } from './browser.service';
import { AccessibilityScannerFactory } from './accessibility-scanner-factory.service';
import { RuleServiceFactory } from './rule-service-factory.service';

/**
 * Background job processor for asynchronous accessibility scan execution.
 * 
 * This service handles the asynchronous processing of accessibility scans queued
 * through the BullMQ job system. It orchestrates the complete scan workflow from
 * browser automation to database persistence, ensuring reliable scan execution
 * with proper error handling and status tracking.
 * 
 * Workflow:
 * 1. Updates scan status to RUNNING when processing begins
 * 2. Launches browser instance for automated page interaction
 * 3. Executes accessibility scan using HTML_CodeSniffer via scanner service
 * 4. Processes and saves individual accessibility issues to database
 * 5. Updates scan status to COMPLETED or FAILED based on results
 * 
 * The processor integrates with BullMQ's retry mechanism, allowing failed scans
 * to be automatically retried with exponential backoff. Status updates ensure
 * API consumers can track scan progress in real-time.
 * 
 * @extends {WorkerHost} BullMQ worker host for job processing
 * @decorator @Processor('scan-processing') Registers as BullMQ processor for scan-processing queue
 */
@Injectable()
@Processor('scan-processing')
export class ScanProcessor extends WorkerHost {
  private readonly logger = new Logger(ScanProcessor.name);

  constructor(
    @InjectRepository(Scan)
    private readonly scanRepository: Repository<Scan>,
    @InjectRepository(Issue)
    private readonly issueRepository: Repository<Issue>,
    private readonly browserService: BrowserService,
    private readonly scannerFactory: AccessibilityScannerFactory,
    private readonly ruleServiceFactory: RuleServiceFactory,
  ) {
    super();
  }

  /**
   * Processes accessibility scan jobs from the BullMQ queue.
   * 
   * This is the main entry point for scan job execution. It manages the complete
   * scan lifecycle including status updates, error handling, and result persistence.
   * The method ensures proper scan status tracking and integrates with BullMQ's
   * retry mechanism for reliable processing.
   * 
   * Processing steps:
   * 1. Extract scan ID and URL from job data
   * 2. Update scan status to RUNNING to indicate processing start
   * 3. Execute accessibility scan through browser automation
   * 4. Save scan results and issues to database
   * 5. Update final status (COMPLETED or FAILED)
   * 
   * Error handling re-throws exceptions to trigger BullMQ's automatic retry
   * mechanism with exponential backoff for transient failures.
   * 
   * @param job - BullMQ job containing scan data (scanId, url)
   * @throws {Error} Re-throws scan errors to trigger BullMQ retry mechanism
   */
  async process(job: Job<ScanJobData>): Promise<void> {
    const { scanId, url, rootElement, scannerType } = job.data;

    this.logger.log(`Processing scan ${scanId} for URL: ${url} using ${scannerType} scanner${rootElement ? ` (rootElement: ${rootElement})` : ''}`);

    try {
      // Update scan status to RUNNING
      await this.updateScanStatus(scanId, ScanStatus.RUNNING);

      // Perform accessibility scanning process with the specified scanner
      await this.performAccessibilityScan(scanId, url, rootElement, scannerType);

      // Update scan status to COMPLETED
      await this.updateScanStatus(scanId, ScanStatus.COMPLETED);

      this.logger.log(`Successfully completed scan ${scanId}`);
    } catch (error) {
      this.logger.error(`Failed to process scan ${scanId}:`, error);

      // Update scan status to FAILED (BullMQ will handle retries)
      await this.updateScanStatus(scanId, ScanStatus.FAILED);

      throw error; // Re-throw to trigger BullMQ retry mechanism
    }
  }

  /**
   * Executes the actual accessibility scan using browser automation and the specified scanner.
   * 
   * This method coordinates the technical scanning process by:
   * - Obtaining a browser instance from the browser service
   * - Getting the appropriate scanner based on scannerType
   * - Running accessibility analysis through the scanner service
   * - Processing scan results into database-ready format
   * - Persisting accessibility issues with proper relationships
   * 
   * The scan uses a 30-second timeout to handle slow-loading pages while preventing
   * indefinite hanging. Browser instances are managed by the browser service to
   * optimize resource usage and ensure proper cleanup.
   * 
   * @param scanId - Unique identifier of the scan being processed
   * @param url - Target URL to scan for accessibility issues
   * @param rootElement - Optional CSS selector to limit scanning scope
   * @param scannerType - Type of accessibility scanner to use
   * @throws {Error} When browser automation, scanning, or data persistence fails
   */
  private async performAccessibilityScan(
    scanId: number,
    url: string,
    rootElement?: string,
    scannerType?: ScannerType,
  ): Promise<void> {
    try {
      // Get the browser instance
      const browser = await this.browserService.getBrowser();

      // Get the appropriate scanner for the specified type
      const scanner = this.scannerFactory.getScanner(scannerType);

      // Build scan options, only including rootElement if provided
      const scanOptions: any = {
        timeout: 30000, // 30 second timeout
      };
      
      if (rootElement) {
        scanOptions.rootElement = rootElement;
      }

      // Run accessibility scan using the specified scanner
      const partialIssues = await scanner.scan(url, browser, scanOptions);

      // Save issues to database
      await this.saveIssues(scanId, partialIssues);

      this.logger.log(
        `Saved ${partialIssues.length} accessibility issues for scan ${scanId} using ${scannerType} scanner`,
      );
    } catch (error) {
      this.logger.error(`Accessibility scan failed for scan ${scanId}:`, error);
      throw error;
    }
  }

  /**
   * Persists accessibility issues to the database with proper scan relationships.
   * 
   * This method creates and saves individual Issue entities for each accessibility
   * problem identified during scanning. It establishes the foreign key relationship
   * between issues and their parent scan, enabling proper data organization and queries.
   * 
   * Each issue is saved individually to ensure partial success in case of database
   * errors and to provide detailed logging for debugging. Optional fields like
   * selector, context, and screenshot filename are preserved when available.
   * 
   * Debug logging includes key issue information to aid troubleshooting and
   * validation of scan results during development.
   * 
   * @param scanId - The parent scan ID to associate issues with
   * @param partialIssues - Array of partial Issue entities from scanner service
   */
  private async saveIssues(
    scanId: number,
    partialIssues: Partial<Issue>[],
  ): Promise<void> {
    for (const partialIssue of partialIssues) {
      // Create issue with proper relationships
      const issue = this.issueRepository.create({
        // Create a minimal Scan reference object for the foreign key relationship
        scan: { id: scanId } as Pick<Scan, 'id'>,
        ruleId: partialIssue.ruleId!,
        description: partialIssue.description,
        impact: partialIssue.impact,
        selector: partialIssue.selector || undefined,
        context: partialIssue.context || undefined,
        screenshotFilename: partialIssue.screenshotFilename || undefined,
      });

      await this.issueRepository.save(issue);
      this.logger.debug(
        `Saved issue for rule '${partialIssue.ruleId}' with data: description="${partialIssue.description}", impact="${partialIssue.impact}", screenshot="${partialIssue.screenshotFilename || 'none'}"`,
      );
    }
  }

  /**
   * Updates the status of a scan in the database.
   * 
   * This utility method provides atomic status updates for scan entities,
   * enabling real-time status tracking throughout the scan processing lifecycle.
   * Status updates are crucial for API consumers to monitor scan progress.
   * 
   * @param scanId - Unique identifier of the scan to update
   * @param status - New status value (RUNNING, COMPLETED, or FAILED)
   */
  private async updateScanStatus(
    scanId: number,
    status: ScanStatus,
  ): Promise<void> {
    await this.scanRepository.update(scanId, { status });
  }
}
