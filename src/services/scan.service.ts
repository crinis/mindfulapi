import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Scan } from '../entities/scan.entity';
import { Issue } from '../entities/issue.entity';
import { CreateScanDto } from '../dto/create-scan.dto';
import { ScanStatus } from '../enums/scan-status.enum';
import { ScannerType, DEFAULT_SCANNER_TYPE } from '../enums/scanner-type.enum';
import { ScanQueueService } from './scan-queue.service';
import { RuleServiceFactory } from './rule-service-factory.service';
import { ScanResponseDto } from '../dto/scan-response.dto';
import { DEFAULT_LANGUAGE } from '../types/language.types';

/**
 * Core service for managing accessibility scans and their lifecycle.
 * 
 * Handles scan creation, queuing for background processing, and data retrieval
 * with enriched rule information. Manages the relationship between scans and
 * their associated accessibility issues, providing structured violation data
 * grouped by rule type.
 * 
 * Features:
 * - Asynchronous scan processing via job queues
 * - Rule-based violation grouping and enrichment
 * - Screenshot URL generation for accessibility issues
 * - Comprehensive scan history and filtering
 */
@Injectable()
export class ScanService {
  private readonly logger = new Logger(ScanService.name);

  constructor(
    @InjectRepository(Scan)
    private readonly scanRepository: Repository<Scan>,
    private readonly scanQueueService: ScanQueueService,
    private readonly ruleServiceFactory: RuleServiceFactory,
  ) {}

  /**
   * Creates a new accessibility scan and queues it for asynchronous processing.
   * 
   * The scan is immediately persisted with PENDING status and added to the
   * background job queue for processing. Returns the scan with enriched
   * violation data (initially empty) and proper screenshot URL generation.
   * 
   * @param createScanDto - Scan configuration including target URL and language preference
   * @param baseUrl - Base URL for generating accessible screenshot URLs (optional)
   * @returns Promise resolving to the created scan with enriched rule information
   * @throws {Error} When scan creation or queue operation fails
   */
  async create(createScanDto: CreateScanDto, baseUrl?: string): Promise<ScanResponseDto> {
    const language = createScanDto.language || DEFAULT_LANGUAGE;
    const scannerType = createScanDto.scannerType || DEFAULT_SCANNER_TYPE;
    
    const scan = this.scanRepository.create({
      url: createScanDto.url,
      language,
      rootElement: createScanDto.rootElement, // Only set if provided, no default
      scannerType,
      status: ScanStatus.PENDING,
    });

    const savedScan = await this.scanRepository.save(scan);

    // Queue scan for background processing with minimal delay to ensure DB commit
    await this.scanQueueService.addScanJob(
      savedScan.id,
      createScanDto.url,
      language,
      createScanDto.rootElement,
      scannerType,
      createScanDto.ruleIds,
    );

    return this.findOne(savedScan.id, baseUrl);
  }

  /**
   * Retrieves all scans with enriched violation and rule information.
   * 
   * Returns scans ordered by creation date (newest first) with complete
   * issue details grouped by accessibility rule. Each issue includes
   * contextual information and screenshot URLs when available.
   * 
   * @param baseUrl - Base URL for generating accessible screenshot URLs (optional)
   * @returns Promise resolving to array of enriched scan response DTOs
   */
  async findAll(baseUrl?: string): Promise<ScanResponseDto[]> {
    const scans = await this.scanRepository.find({
      relations: ['issues'],
      order: { createdAt: 'DESC' },
    });

    return scans.map((scan) => this.enrichScanData(scan, baseUrl));
  }

  /**
   * Retrieves a specific scan by ID with complete violation and rule information.
   * 
   * Returns the scan with all associated accessibility issues grouped by rule,
   * including help URLs, impact levels, and screenshot resources. Each violation
   * contains detailed contextual information for developers to understand and fix issues.
   * 
   * @param id - Unique scan identifier
   * @param baseUrl - Base URL for generating accessible screenshot URLs (optional)
   * @returns Promise resolving to the enriched scan response DTO
   * @throws {NotFoundException} When scan with specified ID doesn't exist
   */
  async findOne(id: number, baseUrl?: string): Promise<ScanResponseDto> {
    const scan = await this.scanRepository.findOne({
      where: { id },
      relations: ['issues'],
    });

    if (!scan) {
      throw new NotFoundException(`Scan with ID ${id} not found`);
    }

    // Always return enriched data with violation grouping and URLs
    return this.enrichScanData(scan, baseUrl);
  }

  /**
   * Transforms raw scan data into structured violation information for API consumption.
   * 
   * Groups individual accessibility issues by rule ID, enriches with help URLs and
   * contextual information, and generates accessible screenshot URLs. This creates
   * a developer-friendly structure where violations are organized by type rather
   * than individual DOM elements.
   * 
   * Processing includes:
   * - Issue grouping by accessibility rule ID
   * - Help URL generation for each rule type
   * - Screenshot URL construction for visual issue context
   * - Issue counting and impact level preservation
   * 
   * @param scan - Raw scan entity with associated issues from database
   * @param baseUrl - Base URL for generating accessible screenshot URLs (optional)
   * @returns Enriched scan response DTO with structured violation data
   */
  private enrichScanData(scan: Scan, baseUrl?: string): ScanResponseDto {
    // Group individual issues by their accessibility rule for better organization
    const rulesMap = new Map<string, Issue[]>();
    scan.issues.forEach((issue) => {
      if (!rulesMap.has(issue.ruleId)) {
        rulesMap.set(issue.ruleId, []);
      }
      rulesMap.get(issue.ruleId)!.push(issue);
    });

    let totalIssues = 0;
    const violations = Array.from(rulesMap.entries()).map(
      ([ruleId, issues]) => {
        const issueCount = issues.length;
        totalIssues += issueCount;

        // Transform issues with screenshot URL generation
        const issueDetails = issues.map((issue) => ({
          id: issue.id,
          selector: issue.selector,
          context: issue.context,
          // Generate full screenshot URL only when filename exists and base URL is available
          screenshotUrl: issue.screenshotFilename && baseUrl 
            ? `${baseUrl}/screenshots/${issue.screenshotFilename}`
            : undefined,
        }));

        // Get the appropriate rule service for this scanner type and generate help URLs
        const ruleService = this.ruleServiceFactory.getRuleService(scan.scannerType);
        const urls = ruleService.getHelpUrls(ruleId);

        // Use issue data from scan results (preserves original scanner output)
        const firstIssue = issues[0];
        const description = firstIssue.description;
        const impact = firstIssue.impact;

        return {
          rule: {
            id: ruleId,
            description,
            impact,
            urls,
          },
          issueCount,
          issues: issueDetails,
        };
      },
    );

    return {
      id: scan.id,
      url: scan.url,
      language: scan.language,
      rootElement: scan.rootElement,
      scannerType: scan.scannerType,
      status: scan.status,
      violations,
      totalIssueCount: totalIssues,
      createdAt: scan.createdAt,
      updatedAt: scan.updatedAt,
    };
  }

  /**
   * Retrieves all accessibility scans for a specific URL with complete violation history.
   * 
   * This method enables tracking accessibility changes over time for a particular webpage.
   * Results include complete violation data, issue details, and screenshot URLs for each
   * scan iteration. Scans are returned in reverse chronological order (newest first).
   * 
   * Use cases:
   * - Monitoring accessibility improvements after fixes
   * - Tracking regression patterns for specific pages
   * - Analyzing accessibility trends over time
   * 
   * @param url - The target URL to retrieve scan history for
   * @param baseUrl - Base URL for generating accessible screenshot URLs (optional)
   * @returns Array of enriched scan response DTOs ordered by creation date (newest first)
   */
  async findByUrl(url: string, baseUrl?: string): Promise<ScanResponseDto[]> {
    const scans = await this.scanRepository.find({
      where: { url },
      relations: ['issues'],
      order: { createdAt: 'DESC' },
    });

    return scans.map((scan) => this.enrichScanData(scan, baseUrl));
  }

  /**
   * Permanently removes a scan and all associated accessibility issues from the database.
   * 
   * This operation cascades to delete all related issue records and any associated
   * screenshot files. Use with caution as this action cannot be undone.
   * 
   * Note: This method does not currently clean up screenshot files from disk.
   * Consider implementing file cleanup for production environments.
   * 
   * @param id - Unique identifier of the scan to remove
   * @throws {NotFoundException} When scan with specified ID doesn't exist
   */
  async remove(id: number): Promise<void> {
    const scan = await this.findRawScan(id);
    await this.scanRepository.remove(scan);
  }

  /**
   * Retrieves a raw scan entity with all associated issues for internal operations.
   * 
   * This is a utility method used internally by other service methods that need
   * direct access to the scan entity without enrichment processing. Returns the
   * scan with full issue relations loaded for database operations.
   * 
   * @param id - Unique scan identifier to retrieve
   * @returns Raw scan entity with associated issues
   * @throws {NotFoundException} When scan with specified ID doesn't exist
   * @private
   */
  private async findRawScan(id: number): Promise<Scan> {
    const scan = await this.scanRepository.findOne({
      where: { id },
      relations: ['issues'],
    });

    if (!scan) {
      throw new NotFoundException(`Scan with ID ${id} not found`);
    }

    return scan;
  }
}
