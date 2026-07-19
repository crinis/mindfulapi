import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Scan } from '../entities/scan.entity';
import { Issue } from '../entities/issue.entity';
import { AgentFinding } from '../entities/agent-finding.entity';
import { IssueImpact } from '../enums/issue-impact.enum';
import { AgentSkill } from '../enums/agent-skill.enum';
import {
  CreateScanRequest,
  CreateSingleUrlScanDto,
  CreateUrlListScanDto,
  CreateCrawlScanDto,
  CrawlOptionsDto,
  ScanOptionsDto,
  AiAuditRequestDto,
} from '../dto/scan/request';
import { ScanStatus } from '../enums/scan-status.enum';
import { ScanMode } from '../enums/scan-mode.enum';
import { ScanQueueService } from './scan-queue.service';
import { BasicAuth } from './axe-accessibility-scanner.service';
import { BasicAuthCryptoService } from './basic-auth-crypto.service';
import { UrlPolicyService } from './url-policy.service';
import { agentConfig } from '../config/configuration';
import {
  ScanResponseDto,
  ScanSummaryResponseDto,
  IssueCountsDto,
  AgentFindingResponseDto,
  AiAuditResponseDto,
  AiAuditStatus,
} from '../dto/scan/response';
import { PaginatedResponseDto } from '../dto/pagination/paginated-response.dto';
import { DEFAULT_CRAWL_OPTIONS } from '../constants/crawl-options.constants';
import {
  normalizeAndDedupeHttpUrls,
  normalizeHttpUrl,
} from '../utils/url-normalization.util';
import { ValidationProblemException } from '../exceptions/validation-problem.exception';

/**
 * Canonical normalized create payload used internally for persistence/queueing.
 */
interface NormalizedCreateInput {
  /** Selected scan mode. */
  mode: ScanMode;
  /** Normalized URL targets (single/list/crawl seeds). */
  targets: string[];
  /** Sanitized axe scan options. */
  scanOptions: {
    rootElement: string;
    ruleIds: string[];
    basicAuth: BasicAuth | null;
  };
  /** Effective crawl options or `null` for non-crawl runs. */
  crawlOptions: Required<CrawlOptionsDto> | null;
}

/**
 * Core service for managing accessibility scans and their lifecycle.
 */
@Injectable()
export class ScanService {
  private readonly logger = new Logger(ScanService.name);

  /**
   * @param scanRepository Scan aggregate repository.
   * @param scanQueueService Queue abstraction used to trigger async processing.
   */
  constructor(
    @InjectRepository(Scan)
    private readonly scanRepository: Repository<Scan>,
    @InjectRepository(Issue)
    private readonly issueRepository: Repository<Issue>,
    @InjectRepository(AgentFinding)
    private readonly agentFindingRepository: Repository<AgentFinding>,
    private readonly scanQueueService: ScanQueueService,
    private readonly basicAuthCryptoService: BasicAuthCryptoService,
    private readonly urlPolicyService: UrlPolicyService,
    @Inject(agentConfig.KEY)
    private readonly agentSettings: ConfigType<typeof agentConfig>,
  ) {}

  /**
   * Validates and persists a new scan run, then enqueues background processing.
   *
   * @param createScanDto Raw user request payload.
   * @returns Fully enriched scan response for the created run.
   */
  async create(createScanDto: CreateScanRequest): Promise<ScanResponseDto> {
    const normalized = this.normalizeCreateInput(createScanDto);
    const aiAuditSkills = this.resolveRequestedSkills(
      normalized.mode,
      createScanDto.aiAudit,
    );
    await this.urlPolicyService.assertAllowedTargets(normalized.targets);
    const encryptedBasicAuth = normalized.scanOptions.basicAuth
      ? this.basicAuthCryptoService.encryptCredentials(
          normalized.scanOptions.basicAuth,
        )
      : null;
    const scan = this.scanRepository.create({
      mode: normalized.mode,
      targets: normalized.targets,
      rootElement: normalized.scanOptions.rootElement || undefined,
      ruleIds: normalized.scanOptions.ruleIds.length
        ? normalized.scanOptions.ruleIds
        : null,
      basicAuthUsernameEncrypted: encryptedBasicAuth?.encryptedUsername ?? null,
      basicAuthPasswordEncrypted: encryptedBasicAuth?.encryptedPassword ?? null,
      crawlMaxPages: normalized.crawlOptions?.maxPages ?? null,
      crawlMaxDepth: normalized.crawlOptions?.maxDepth ?? null,
      crawlStrategy: normalized.crawlOptions?.strategy ?? null,
      crawlGlobs: normalized.crawlOptions?.globs.length
        ? normalized.crawlOptions.globs
        : null,
      crawlExcludeGlobs: normalized.crawlOptions?.excludeGlobs.length
        ? normalized.crawlOptions.excludeGlobs
        : null,
      aiAuditSkills,
      status: ScanStatus.PENDING,
    });

    const savedScan = await this.scanRepository.save(scan);

    try {
      await this.scanQueueService.addScanJob(savedScan.id);
    } catch (error) {
      // The row exists but could not be queued (e.g. Redis down). Leave it
      // PENDING — the reconciliation sweep only re-enqueues stale PENDING/
      // RUNNING scans, so marking it FAILED would strand it in a terminal
      // state forever. The 503 tells the caller the create did not fully take.
      this.logger.error(
        `Failed to enqueue scan ${savedScan.id}: ${String(error)}`,
      );
      throw new ServiceUnavailableException(
        'Scan was created but could not be queued for processing. Please retry.',
      );
    }

    savedScan.issues = [];
    savedScan.agentFindings = [];
    return this.enrichScanData(savedScan);
  }

  /**
   * Validates a requested AI audit against the server configuration, returning
   * the deduped skill list to persist (or `null` when not requested).
   *
   * @throws BadRequestException When AI audit is disabled server-side, the
   * scan mode is not allowed, or a requested skill is not whitelisted.
   */
  private resolveRequestedSkills(
    scanMode: ScanMode,
    aiAudit?: AiAuditRequestDto,
  ): AgentSkill[] | null {
    // The request validator rejects null, but keep this boundary defensive for
    // callers that invoke the service without going through the HTTP pipe.
    if (aiAudit === undefined || aiAudit === null) {
      return null;
    }
    if (!this.agentSettings.enabled) {
      throw new BadRequestException('AI audit is not enabled on this server.');
    }
    if (!this.agentSettings.allowedScanModes.includes(scanMode)) {
      throw new ValidationProblemException([
        {
          pointer: '/aiAudit',
          message:
            `AI audit is not allowed for scan mode '${scanMode}' on this server. ` +
            `Allowed scan modes: ${this.agentSettings.allowedScanModes.join(', ')}.`,
        },
      ]);
    }
    const known = new Set<string>(Object.values(AgentSkill));
    const allowed = new Set<AgentSkill>(
      this.agentSettings.allowedSkills.filter((skill): skill is AgentSkill =>
        known.has(skill),
      ),
    );
    const requested = aiAudit.skills ?? [...allowed];
    if (requested.length === 0) {
      throw new BadRequestException(
        'No AI audit skills are enabled on this server.',
      );
    }
    const rejected = requested.filter((skill) => !allowed.has(skill));
    if (rejected.length > 0) {
      throw new BadRequestException(
        `Requested AI audit skills are not enabled on this server: ${rejected.join(', ')}`,
      );
    }
    return Array.from(new Set(requested));
  }

  /**
   * Cancels a scan run. Removes a queued job and marks the scan CANCELED so a
   * running worker stops cooperatively.
   *
   * @param id Scan run identifier.
   * @throws NotFoundException When no run exists for the given ID.
   * @throws ConflictException When the scan is already in a terminal state.
   */
  async cancel(id: number): Promise<ScanResponseDto> {
    const scan = await this.scanRepository.findOne({ where: { id } });
    if (!scan) {
      throw new NotFoundException(`Scan with ID ${id} not found`);
    }

    const terminal = [
      ScanStatus.COMPLETED,
      ScanStatus.FAILED,
      ScanStatus.CANCELED,
    ];
    if (terminal.includes(scan.status)) {
      throw new ConflictException(
        `Scan ${id} is already ${scan.status} and cannot be canceled.`,
      );
    }

    await this.scanQueueService.cancelScanJob(id);
    await this.scanRepository.update(id, { status: ScanStatus.CANCELED });

    return this.findOne(id);
  }

  /**
   * Lists scan runs as lightweight summaries (no per-issue detail), paginated
   * and ordered by creation date descending.
   *
   * @param options Pagination bounds and optional target filter.
   * @returns A page of scan summaries with per-severity issue counts.
   */
  async findAll(options: {
    limit: number;
    offset: number;
    target?: string;
  }): Promise<PaginatedResponseDto<ScanSummaryResponseDto>> {
    const normalizedTarget = options.target
      ? normalizeHttpUrl(options.target)
      : null;

    const query = this.scanRepository
      .createQueryBuilder('scan')
      .orderBy('scan.createdAt', 'DESC')
      .skip(options.offset)
      .take(options.limit);

    if (normalizedTarget) {
      // Match against the simple-json text column. Wrapping the value in the
      // JSON element quotes (`"<url>"`) makes the LIKE an exact-element match:
      // it excludes substring hits like a stored `.../path` for target `...`,
      // which would otherwise consume the SQL limit/offset and inflate `total`
      // before the JS confirmation below. The confirm stays as defense in depth.
      query.andWhere('scan.targets LIKE :target', {
        target: `%"${normalizedTarget}"%`,
      });
    }

    const [scans, total] = await query.getManyAndCount();

    const confirmed = normalizedTarget
      ? scans.filter((scan) =>
          (scan.targets || []).some(
            (target) => normalizeHttpUrl(target) === normalizedTarget,
          ),
        )
      : scans;

    const scanIds = confirmed.map((scan) => scan.id);
    const countsByScan = await this.issueCountsForScans(scanIds);
    const agentCountsByScan = await this.agentFindingCountsForScans(scanIds);

    return {
      items: confirmed.map((scan) =>
        this.toSummary(
          scan,
          countsByScan.get(scan.id),
          agentCountsByScan.get(scan.id) ?? 0,
        ),
      ),
      total,
      limit: options.limit,
      offset: options.offset,
    };
  }

  /**
   * Counts agent findings per scan in a single grouped query.
   *
   * @param scanIds Scans to count findings for.
   * @returns Map of scanId → agent finding count.
   */
  private async agentFindingCountsForScans(
    scanIds: number[],
  ): Promise<Map<number, number>> {
    const result = new Map<number, number>();
    if (scanIds.length === 0) {
      return result;
    }
    const rows = await this.agentFindingRepository
      .createQueryBuilder('finding')
      .select('finding.scanId', 'scanId')
      .addSelect('COUNT(*)', 'count')
      .where('finding.scanId IN (:...scanIds)', { scanIds })
      .groupBy('finding.scanId')
      .getRawMany<{ scanId: number; count: string }>();
    for (const row of rows) {
      result.set(Number(row.scanId), Number(row.count));
    }
    return result;
  }

  /**
   * Retrieves one scan run by ID with full grouped violations.
   *
   * @param id Scan run identifier.
   * @param pageUrls Optional page URL filters used to include only matching issues.
   * @throws NotFoundException When no run exists for the given ID.
   */
  async findOne(id: number, pageUrls?: string[]): Promise<ScanResponseDto> {
    const scan = await this.scanRepository.findOne({ where: { id } });

    if (!scan) {
      throw new NotFoundException(`Scan with ID ${id} not found`);
    }

    const normalizedPageUrls = pageUrls?.length
      ? normalizeAndDedupeHttpUrls(pageUrls)
      : null;

    // Issues are persisted with normalized pageUrls, so the filter runs in SQL.
    scan.issues = await this.issueRepository.find({
      where: {
        scan: { id },
        ...(normalizedPageUrls?.length
          ? { pageUrl: In(normalizedPageUrls) }
          : {}),
      },
    });

    scan.agentFindings = await this.agentFindingRepository.find({
      where: {
        scan: { id },
        ...(normalizedPageUrls?.length
          ? { pageUrl: In(normalizedPageUrls) }
          : {}),
      },
      order: { id: 'ASC' },
    });

    return this.enrichScanData(scan);
  }

  /**
   * Aggregates issue counts per scan and severity in a single grouped query.
   *
   * @param scanIds Scans to count issues for.
   * @returns Map of scanId → severity counts.
   */
  private async issueCountsForScans(
    scanIds: number[],
  ): Promise<Map<number, IssueCountsDto>> {
    const result = new Map<number, IssueCountsDto>();
    if (scanIds.length === 0) {
      return result;
    }

    const rows = await this.issueRepository
      .createQueryBuilder('issue')
      .select('issue.scanId', 'scanId')
      .addSelect('issue.impact', 'impact')
      .addSelect('COUNT(*)', 'count')
      .where('issue.scanId IN (:...scanIds)', { scanIds })
      .groupBy('issue.scanId')
      .addGroupBy('issue.impact')
      .getRawMany<{ scanId: number; impact: IssueImpact; count: string }>();

    for (const scanId of scanIds) {
      result.set(scanId, {
        critical: 0,
        serious: 0,
        moderate: 0,
        minor: 0,
      });
    }

    for (const row of rows) {
      const counts = result.get(Number(row.scanId));
      if (counts && row.impact in counts) {
        counts[row.impact] = Number(row.count);
      }
    }

    return result;
  }

  /**
   * Builds a list-view summary from a scan and its precomputed issue counts.
   */
  private toSummary(
    scan: Scan,
    counts: IssueCountsDto | undefined,
    agentFindingCount: number,
  ): ScanSummaryResponseDto {
    const issueCounts = counts ?? {
      critical: 0,
      serious: 0,
      moderate: 0,
      minor: 0,
    };

    return {
      id: scan.id,
      mode: scan.mode,
      targets: scan.targets,
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
              strategy: scan.crawlStrategy ?? DEFAULT_CRAWL_OPTIONS.strategy,
              globs: scan.crawlGlobs || [],
              excludeGlobs: scan.crawlExcludeGlobs || [],
            }
          : null,
      progress: {
        pagesDiscovered: scan.pagesDiscovered ?? 0,
        pagesScanned: scan.pagesScanned ?? 0,
        pagesFailed: scan.pagesFailed ?? 0,
      },
      issueCounts,
      totalIssueCount:
        issueCounts.critical +
        issueCounts.serious +
        issueCounts.moderate +
        issueCounts.minor,
      aiAudit: this.buildAiAudit(scan),
      agentFindingCount,
      createdAt: scan.createdAt,
      updatedAt: scan.updatedAt,
    };
  }

  /**
   * Deletes a scan run and related issues.
   *
   * @param id Scan run identifier.
   * @throws NotFoundException When no run exists for the given ID.
   */
  async remove(id: number): Promise<void> {
    // Best-effort: drop any queued job so a deleted scan isn't processed.
    await this.scanQueueService.cancelScanJob(id).catch(() => undefined);

    const result = await this.scanRepository.delete(id);

    if (!result.affected) {
      throw new NotFoundException(`Scan with ID ${id} not found`);
    }
  }

  /**
   * Normalizes and validates create input across all scan modes.
   */
  private normalizeCreateInput(dto: CreateScanRequest): NormalizedCreateInput {
    const scanOptions = this.sanitizeScanOptions(dto.scanOptions);

    // The request body is already validated (including cross-field rejection)
    // by DiscriminatedBodyPipe, so each branch narrows to its variant type.
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
  private sanitizeScanOptions(scanOptions?: ScanOptionsDto): {
    rootElement: string;
    ruleIds: string[];
    basicAuth: BasicAuth | null;
  } {
    return {
      rootElement: scanOptions?.rootElement?.trim() || '',
      ruleIds: this.dedupeStrings(scanOptions?.ruleIds || []),
      basicAuth: this.sanitizeBasicAuth(scanOptions?.basicAuth),
    };
  }

  /**
   * Returns normalized basic-auth credentials or `null` when not configured.
   */
  private sanitizeBasicAuth(
    basicAuth: ScanOptionsDto['basicAuth'],
  ): BasicAuth | null {
    if (!basicAuth) return null;
    return {
      username: basicAuth.username.trim(),
      password: basicAuth.password,
    };
  }

  /**
   * Validates and normalizes `single_url` mode payload.
   */
  private normalizeSingleUrlMode(
    dto: CreateSingleUrlScanDto,
    scanOptions: NormalizedCreateInput['scanOptions'],
  ): NormalizedCreateInput {
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
    dto: CreateUrlListScanDto,
    scanOptions: NormalizedCreateInput['scanOptions'],
  ): NormalizedCreateInput {
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
    dto: CreateCrawlScanDto,
    scanOptions: NormalizedCreateInput['scanOptions'],
  ): NormalizedCreateInput {
    return {
      mode: dto.mode,
      targets: this.requireValidUrlList(dto.startUrls),
      scanOptions,
      crawlOptions: this.buildCrawlOptions(dto.crawlOptions),
    };
  }

  /**
   * Merges user crawl options with defaults and deduplicates glob arrays.
   */
  private buildCrawlOptions(
    crawlOptions?: CrawlOptionsDto,
  ): Required<CrawlOptionsDto> {
    return {
      ...DEFAULT_CRAWL_OPTIONS,
      ...(crawlOptions || {}),
      strategy: crawlOptions?.strategy ?? DEFAULT_CRAWL_OPTIONS.strategy,
      globs: this.dedupeStrings(crawlOptions?.globs || []),
      excludeGlobs: this.dedupeStrings(crawlOptions?.excludeGlobs || []),
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
      let group = rulesMap.get(key);
      if (!group) {
        group = [];
        rulesMap.set(key, group);
      }
      group.push(issue);
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
      targets: scan.targets,
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
              strategy: scan.crawlStrategy ?? DEFAULT_CRAWL_OPTIONS.strategy,
              globs: scan.crawlGlobs || [],
              excludeGlobs: scan.crawlExcludeGlobs || [],
            }
          : null,
      progress: {
        pagesDiscovered: scan.pagesDiscovered ?? 0,
        pagesScanned: scan.pagesScanned ?? 0,
        pagesFailed: scan.pagesFailed ?? 0,
      },
      violations,
      totalIssueCount: violations.reduce((sum, v) => sum + v.issues.length, 0),
      aiAudit: this.buildAiAudit(scan),
      agentFindings: (scan.agentFindings ?? []).map((finding) =>
        this.toAgentFinding(finding),
      ),
      createdAt: scan.createdAt,
      updatedAt: scan.updatedAt,
    };
  }

  /** Maps a persisted agent finding to its response shape. */
  private toAgentFinding(finding: AgentFinding): AgentFindingResponseDto {
    return {
      skill: finding.skill,
      category: finding.category,
      wcag: finding.wcag ?? null,
      severity: finding.severity,
      confidence: finding.confidence,
      needsHumanReview: finding.needsHumanReview ?? false,
      pageUrl: finding.pageUrl ?? null,
      selector: finding.selector ?? null,
      message: finding.message,
      suggestion: finding.suggestion ?? null,
      details: finding.details ?? null,
      model: finding.model ?? null,
    };
  }

  /**
   * Builds the AI-audit summary for a scan, or `null` when the audit was not
   * requested. The status is derived from the scan lifecycle status.
   */
  private buildAiAudit(scan: Scan): AiAuditResponseDto | null {
    const skills = scan.aiAuditSkills;
    if (!skills?.length) {
      return null;
    }
    return {
      status: this.aiAuditStatus(scan),
      requestedSkills: skills,
      tasksTotal: scan.aiTasksTotal ?? 0,
      tasksCompleted: scan.aiTasksCompleted ?? 0,
      tasksFailed: scan.aiTasksFailed ?? 0,
    };
  }

  /**
   * Derives the AI-audit phase status from the scan lifecycle. A completed scan
   * that produced no work units (nothing eligible, or the feature/skill was
   * disabled after creation) reports `skipped` rather than `completed`; a scan
   * that failed or was canceled likewise reports `skipped` since the audit
   * never finished.
   */
  private aiAuditStatus(scan: Scan): AiAuditStatus {
    switch (scan.status) {
      case ScanStatus.COMPLETED:
        return (scan.aiTasksTotal ?? 0) > 0
          ? AiAuditStatus.COMPLETED
          : AiAuditStatus.SKIPPED;
      case ScanStatus.ANALYZING:
        return AiAuditStatus.RUNNING;
      case ScanStatus.FAILED:
      case ScanStatus.CANCELED:
        return AiAuditStatus.SKIPPED;
      default:
        return AiAuditStatus.PENDING;
    }
  }
}
