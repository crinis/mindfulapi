import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Scan } from '../entities/scan.entity';
import { Issue } from '../entities/issue.entity';
import {
  CreateScanDto,
  CrawlOptionsDto,
  ScanOptionsDto,
} from '../dto/scan/request';
import { ScanStatus } from '../enums/scan-status.enum';
import { ScanMode } from '../enums/scan-mode.enum';
import { ScanQueueService } from './scan-queue.service';
import { ScanResponseDto } from '../dto/scan/response';
import { DEFAULT_CRAWL_OPTIONS } from '../constants/crawl-options.constants';
import {
  normalizeAndDedupeHttpUrls,
  normalizeHttpUrl,
} from '../utils/url-normalization.util';
import { compileRegexPatterns } from '../utils/regex.util';

/**
 * Canonical normalized create payload used internally for persistence/queueing.
 */
interface NormalizedCreateInput {
  /** Selected scan mode. */
  mode: ScanMode;
  /** Normalized URL targets (single/list/crawl seeds). */
  targets: string[];
  /** Sanitized axe scan options. */
  scanOptions: Required<Pick<ScanOptionsDto, 'rootElement' | 'ruleIds'>>;
  /** Effective crawl options or `null` for non-crawl runs. */
  crawlOptions: Required<CrawlOptionsDto> | null;
}

/**
 * Core service for managing accessibility scans and their lifecycle.
 */
@Injectable()
export class ScanService {
  /**
   * @param scanRepository Scan aggregate repository.
   * @param scanQueueService Queue abstraction used to trigger async processing.
   */
  constructor(
    @InjectRepository(Scan)
    private readonly scanRepository: Repository<Scan>,
    private readonly scanQueueService: ScanQueueService,
  ) {}

  /**
   * Validates and persists a new scan run, then enqueues background processing.
   *
   * @param createScanDto Raw user request payload.
   * @returns Fully enriched scan response for the created run.
   */
  async create(createScanDto: CreateScanDto): Promise<ScanResponseDto> {
    const normalized = this.normalizeCreateInput(createScanDto);
    const scan = this.scanRepository.create({
      url: normalized.targets[0],
      mode: normalized.mode,
      targets: normalized.targets,
      rootElement: normalized.scanOptions.rootElement || undefined,
      ruleIds: normalized.scanOptions.ruleIds.length
        ? normalized.scanOptions.ruleIds
        : null,
      crawlMaxPages: normalized.crawlOptions?.maxPages ?? null,
      crawlMaxDepth: normalized.crawlOptions?.maxDepth ?? null,
      crawlSameHostOnly: normalized.crawlOptions?.sameHostOnly ?? null,
      crawlIncludePatterns: normalized.crawlOptions?.includePatterns.length
        ? normalized.crawlOptions.includePatterns
        : null,
      crawlExcludePatterns: normalized.crawlOptions?.excludePatterns.length
        ? normalized.crawlOptions.excludePatterns
        : null,
      crawlConcurrency: normalized.crawlOptions?.concurrency ?? null,
      status: ScanStatus.PENDING,
    });

    const savedScan = await this.scanRepository.save(scan);
    await this.scanQueueService.addScanJob(savedScan.id);
    savedScan.issues = [];
    return this.enrichScanData(savedScan);
  }

  /**
   * Lists scan runs, optionally filtered by a specific target URL.
   *
   * @param options Optional list filters.
   * @returns Enriched scan response objects sorted by creation date descending.
   */
  async findAll(options?: { target?: string }): Promise<ScanResponseDto[]> {
    const normalizedTarget = options?.target
      ? normalizeHttpUrl(options.target)
      : null;

    const scans = await this.scanRepository.find({
      relations: ['issues'],
      order: { createdAt: 'DESC' },
    });

    const filtered = normalizedTarget
      ? scans.filter((scan) =>
          (scan.targets || []).some(
            (target) => normalizeHttpUrl(target) === normalizedTarget,
          ),
        )
      : scans;

    return filtered.map((scan) => this.enrichScanData(scan));
  }

  /**
   * Retrieves one scan run by ID.
   *
   * @param id Scan run identifier.
   * @throws NotFoundException When no run exists for the given ID.
   */
  async findOne(id: number): Promise<ScanResponseDto> {
    const scan = await this.scanRepository.findOne({
      where: { id },
      relations: ['issues'],
    });

    if (!scan) {
      throw new NotFoundException(`Scan with ID ${id} not found`);
    }

    return this.enrichScanData(scan);
  }

  /**
   * Deletes a scan run and related issues.
   *
   * @param id Scan run identifier.
   * @throws NotFoundException When no run exists for the given ID.
   */
  async remove(id: number): Promise<void> {
    const scan = await this.scanRepository.findOne({
      where: { id },
      relations: ['issues'],
    });

    if (!scan) {
      throw new NotFoundException(`Scan with ID ${id} not found`);
    }

    await this.scanRepository.remove(scan);
  }

  /**
   * Normalizes and validates create input across all scan modes.
   */
  private normalizeCreateInput(dto: CreateScanDto): NormalizedCreateInput {
    const scanOptions = this.sanitizeScanOptions(dto.scanOptions);

    switch (dto.mode) {
      case ScanMode.SINGLE_URL:
        return this.normalizeSingleUrlMode(dto, scanOptions);
      case ScanMode.URL_LIST:
        return this.normalizeUrlListMode(dto, scanOptions);
      case ScanMode.CRAWL:
        return this.normalizeCrawlMode(dto, scanOptions);
      default:
        throw new BadRequestException('Unsupported scan mode');
    }
  }

  /**
   * Sanitizes optional scan options into a predictable internal shape.
   */
  private sanitizeScanOptions(
    scanOptions?: ScanOptionsDto,
  ): Required<Pick<ScanOptionsDto, 'rootElement' | 'ruleIds'>> {
    return {
      rootElement: scanOptions?.rootElement?.trim() || '',
      ruleIds: this.dedupeStrings(scanOptions?.ruleIds || []),
    };
  }

  /**
   * Validates and normalizes `single_url` mode payload.
   */
  private normalizeSingleUrlMode(
    dto: CreateScanDto,
    scanOptions: Required<Pick<ScanOptionsDto, 'rootElement' | 'ruleIds'>>,
  ): NormalizedCreateInput {
    if (!dto.url) {
      throw new BadRequestException(
        '`url` is required when mode is single_url',
      );
    }

    if (dto.urls || dto.startUrls || dto.crawlOptions) {
      throw new BadRequestException(
        'Only `url` and `scanOptions` are allowed when mode is single_url',
      );
    }

    return {
      mode: dto.mode,
      targets: [this.requireValidUrl(dto.url)],
      scanOptions,
      crawlOptions: null,
    };
  }

  /**
   * Validates and normalizes `url_list` mode payload.
   */
  private normalizeUrlListMode(
    dto: CreateScanDto,
    scanOptions: Required<Pick<ScanOptionsDto, 'rootElement' | 'ruleIds'>>,
  ): NormalizedCreateInput {
    if (!dto.urls || dto.urls.length < 2) {
      throw new BadRequestException(
        '`urls` with at least 2 entries is required when mode is url_list',
      );
    }

    if (dto.url || dto.startUrls || dto.crawlOptions) {
      throw new BadRequestException(
        'Only `urls` and `scanOptions` are allowed when mode is url_list',
      );
    }

    return {
      mode: dto.mode,
      targets: this.requireValidUrlList(dto.urls),
      scanOptions,
      crawlOptions: null,
    };
  }

  /**
   * Validates and normalizes `crawl` mode payload.
   */
  private normalizeCrawlMode(
    dto: CreateScanDto,
    scanOptions: Required<Pick<ScanOptionsDto, 'rootElement' | 'ruleIds'>>,
  ): NormalizedCreateInput {
    if (!dto.startUrls || dto.startUrls.length === 0) {
      throw new BadRequestException(
        '`startUrls` is required when mode is crawl',
      );
    }

    if (dto.url || dto.urls) {
      throw new BadRequestException(
        '`url` and `urls` are not allowed when mode is crawl',
      );
    }

    const crawlOptions = this.buildCrawlOptions(dto.crawlOptions);

    try {
      compileRegexPatterns(crawlOptions.includePatterns, 'includePatterns');
      compileRegexPatterns(crawlOptions.excludePatterns, 'excludePatterns');
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Invalid regex pattern',
      );
    }

    return {
      mode: dto.mode,
      targets: this.requireValidUrlList(dto.startUrls),
      scanOptions,
      crawlOptions,
    };
  }

  /**
   * Merges user crawl options with defaults and removes duplicate regex entries.
   */
  private buildCrawlOptions(
    crawlOptions?: CrawlOptionsDto,
  ): Required<CrawlOptionsDto> {
    return {
      ...DEFAULT_CRAWL_OPTIONS,
      ...(crawlOptions || {}),
      includePatterns: this.dedupeStrings(crawlOptions?.includePatterns || []),
      excludePatterns: this.dedupeStrings(crawlOptions?.excludePatterns || []),
    };
  }

  /**
   * Trims and deduplicates string arrays while removing empty entries.
   */
  private dedupeStrings(values: string[]): string[] {
    return Array.from(
      new Set(
        values.map((value) => value.trim()).filter((value) => value.length > 0),
      ),
    );
  }

  /**
   * Normalizes and validates URL arrays and ensures at least one valid entry.
   */
  private requireValidUrlList(urls: string[]): string[] {
    const normalized = normalizeAndDedupeHttpUrls(urls);
    if (normalized.length === 0) {
      throw new BadRequestException('At least one valid URL is required');
    }
    return normalized;
  }

  /**
   * Normalizes and validates a single URL.
   */
  private requireValidUrl(url: string): string {
    const normalized = normalizeHttpUrl(url);
    if (!normalized) {
      throw new BadRequestException(`Invalid URL: ${url}`);
    }
    return normalized;
  }

  /**
   * Converts persisted scan and issue entities into the API response contract.
   */
  private enrichScanData(scan: Scan): ScanResponseDto {
    const rulesMap = new Map<string, Issue[]>();
    scan.issues.forEach((issue) => {
      const key = `${issue.ruleId}::${issue.impact}`;
      if (!rulesMap.has(key)) {
        rulesMap.set(key, []);
      }
      rulesMap.get(key)!.push(issue);
    });

    const violations = Array.from(rulesMap.values()).map((issues) => {
      const first = issues[0];

      return {
        rule: {
          id: first.ruleId,
          description: first.description,
          helpUrl: first.helpUrl,
        },
        impact: first.impact,
        issues: issues.map((issue) => ({
          id: issue.id,
          pageUrl: issue.pageUrl ?? null,
          selector: issue.selector ?? null,
          context: issue.context ?? null,
        })),
      };
    });

    return {
      id: scan.id,
      mode: scan.mode,
      targets: scan.targets || [scan.url],
      status: scan.status,
      scanOptions: {
        rootElement: scan.rootElement ?? null,
        ruleIds: scan.ruleIds?.length ? scan.ruleIds : null,
      },
      crawlOptions:
        scan.mode === ScanMode.CRAWL
          ? {
              maxPages: scan.crawlMaxPages ?? DEFAULT_CRAWL_OPTIONS.maxPages,
              maxDepth: scan.crawlMaxDepth ?? DEFAULT_CRAWL_OPTIONS.maxDepth,
              sameHostOnly:
                scan.crawlSameHostOnly ?? DEFAULT_CRAWL_OPTIONS.sameHostOnly,
              includePatterns: scan.crawlIncludePatterns || [],
              excludePatterns: scan.crawlExcludePatterns || [],
              concurrency:
                scan.crawlConcurrency ?? DEFAULT_CRAWL_OPTIONS.concurrency,
            }
          : null,
      progress: {
        pagesDiscovered: scan.pagesDiscovered ?? 0,
        pagesScanned: scan.pagesScanned ?? 0,
        pagesFailed: scan.pagesFailed ?? 0,
      },
      violations,
      totalIssueCount: violations.reduce((sum, v) => sum + v.issues.length, 0),
      createdAt: scan.createdAt,
      updatedAt: scan.updatedAt,
    };
  }
}
