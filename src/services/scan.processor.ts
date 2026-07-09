import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from 'bullmq';
import {
  BasicCrawler,
  Configuration,
  EnqueueStrategy,
  RequestQueue,
} from 'crawlee';
import { MemoryStorage } from '@crawlee/memory-storage';
import type { Page } from 'playwright';
import { Scan } from '../entities/scan.entity';
import { Issue } from '../entities/issue.entity';
import { ScanStatus } from '../enums/scan-status.enum';
import { ScanMode } from '../enums/scan-mode.enum';
import { ScanJobData, SCAN_QUEUE_NAME } from './scan-queue.service';
import { BrowserService } from './browser.service';
import {
  AxeAccessibilityScanner,
  BasicAuth,
  ScanOptions,
  ScannedIssue,
} from './axe-accessibility-scanner.service';
import { BasicAuthCryptoService } from './basic-auth-crypto.service';
import { UrlPolicyService } from './url-policy.service';
import {
  normalizeAndDedupeHttpUrls,
  normalizeHttpUrl,
} from '../utils/url-normalization.util';
import { DEFAULT_CRAWL_OPTIONS } from '../constants/crawl-options.constants';
import { scanConfig } from '../config/configuration';
import { CrawlStrategy } from '../enums/crawl-strategy.enum';
import { truncate } from '../utils/truncate.util';
import { AgentAuditService } from '../agent/agent-audit.service';
import type { AuditSkill } from '../agent/skills/audit-skill.interface';
import type { CollectedUnit } from '../agent/agent-audit.service';

/** Maps the API's snake_case strategy values to Crawlee's kebab-case enum. */
const CRAWL_STRATEGY_TO_ENQUEUE: Record<CrawlStrategy, EnqueueStrategy> = {
  [CrawlStrategy.All]: EnqueueStrategy.All,
  [CrawlStrategy.SameHostname]: EnqueueStrategy.SameHostname,
  [CrawlStrategy.SameDomain]: EnqueueStrategy.SameDomain,
  [CrawlStrategy.SameOrigin]: EnqueueStrategy.SameOrigin,
};

/** Length caps for stored issue fields — SQLite ignores varchar lengths. */
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_SELECTOR_LENGTH = 1000;
const MAX_CONTEXT_LENGTH = 4000;

/** Progress rows are rewritten at most every N ms / every N pages per scan. */
const PROGRESS_WRITE_INTERVAL_MS = 2000;
const PROGRESS_WRITE_PAGE_BATCH = 10;

/**
 * Unit of work for scanning a single page URL.
 */
interface PageTask {
  /** URL that should be analyzed. */
  url: string;
}

/**
 * Per-scan LLM-agent audit state threaded through the page loop: the active
 * skills and an in-memory buffer of collected work units awaiting evaluation.
 */
interface AgentRun {
  skills: AuditSkill[];
  buffer: CollectedUnit[];
}

/**
 * Mutable counters persisted during scan processing.
 */
interface ScanProgress {
  /** Number of unique pages discovered for this run. */
  pagesDiscovered: number;
  /** Number of pages successfully analyzed. */
  pagesScanned: number;
  /** Number of pages that failed processing. */
  pagesFailed: number;
}

/**
 * Batched persister for scan progress counters.
 */
interface ProgressWriter {
  /** Persists unconditionally (initial totals, final flush). */
  flush(progress: ScanProgress): Promise<void>;
  /** Persists only when the page-batch or time threshold is reached. */
  maybePersist(progress: ScanProgress): Promise<void>;
}

/**
 * Background job processor for asynchronous accessibility scan execution.
 */
/**
 * Reads SCAN_CONCURRENCY (1-8, default 1) at import time. The @Processor
 * decorator evaluates before ConfigModule loads, so this reads process.env
 * directly; the value is still bounds-checked by the env validation schema.
 */
function resolveScanConcurrency(): number {
  const raw = parseInt(process.env.SCAN_CONCURRENCY ?? '', 10);
  if (!Number.isFinite(raw)) return 1;
  return Math.min(Math.max(raw, 1), 8);
}

@Injectable()
@Processor(SCAN_QUEUE_NAME, { concurrency: resolveScanConcurrency() })
export class ScanProcessor extends WorkerHost {
  /** Structured service logger for scan processing lifecycle events. */
  private readonly logger = new Logger(ScanProcessor.name);

  /**
   * @param scanRepository Scan repository used for lifecycle/progress updates.
   * @param issueRepository Issue repository used for result persistence.
   * @param browserService Shared browser lifecycle service.
   * @param scanner Axe scanner abstraction for page analysis.
   */
  constructor(
    @InjectRepository(Scan)
    private readonly scanRepository: Repository<Scan>,
    @InjectRepository(Issue)
    private readonly issueRepository: Repository<Issue>,
    private readonly browserService: BrowserService,
    private readonly scanner: AxeAccessibilityScanner,
    private readonly basicAuthCryptoService: BasicAuthCryptoService,
    @Inject(scanConfig.KEY)
    private readonly config: ConfigType<typeof scanConfig>,
    private readonly urlPolicyService: UrlPolicyService,
    private readonly agentAudit: AgentAuditService,
  ) {
    super();
  }

  /**
   * BullMQ worker entrypoint for processing one queued scan job.
   *
   * @param job BullMQ job containing scan ID payload.
   */
  async process(job: Job<ScanJobData>): Promise<void> {
    const { scanId } = job.data;
    const scan = await this.scanRepository
      .createQueryBuilder('scan')
      .addSelect([
        'scan.basicAuthUsernameEncrypted',
        'scan.basicAuthPasswordEncrypted',
      ])
      .where('scan.id = :scanId', { scanId })
      .getOne();

    if (!scan) {
      throw new Error(`Scan ${scanId} not found`);
    }

    this.logger.log(`Processing scan ${scanId} in mode ${scan.mode}`);

    try {
      await this.resetScanResults(scanId);

      const scanOptions: ScanOptions = {
        rootElement: scan.rootElement || undefined,
        ruleIds: scan.ruleIds?.length ? scan.ruleIds : undefined,
        basicAuth: this.resolveBasicAuth(scan),
      };

      // Resolve the optional LLM-agent audit once per scan; empty unless the
      // feature is enabled and the scan requested whitelisted skills.
      const agentSkills = this.agentAudit.resolveSkills(scan);
      const agent: AgentRun | undefined = agentSkills.length
        ? { skills: agentSkills, buffer: [] }
        : undefined;

      const progress =
        scan.mode === ScanMode.CRAWL
          ? await this.performCrawl(scan, scanOptions, agent)
          : await this.performTargetListScan(scan, scanOptions, agent);

      // A cancellation observed mid-run wins over completion; persist the
      // partial counters but leave the CANCELED status in place.
      if (await this.isCanceled(scanId)) {
        await this.persistFinalCounters(scanId, progress);
        this.logger.log(`Scan ${scanId} was canceled`);
        return;
      }

      // Agentic phase: evidence was collected while pages were live; evaluate
      // it now, off the browser, before marking the scan complete.
      if (agent && agent.buffer.length > 0) {
        await this.scanRepository.update(scanId, {
          status: ScanStatus.ANALYZING,
        });
        await this.agentAudit.evaluate(scan, agent.buffer, () =>
          this.isCanceled(scanId),
        );
        if (await this.isCanceled(scanId)) {
          await this.persistFinalCounters(scanId, progress);
          this.logger.log(`Scan ${scanId} was canceled during AI audit`);
          return;
        }
      }

      await this.scanRepository.update(scanId, {
        status: ScanStatus.COMPLETED,
        pagesDiscovered: progress.pagesDiscovered,
        pagesScanned: progress.pagesScanned,
        pagesFailed: progress.pagesFailed,
      });

      this.logger.log(`Completed scan ${scanId}`);
    } catch (error) {
      // BullMQ increments attemptsMade only after an attempt finishes, so the
      // attempt currently running is attemptsMade + 1. Marking FAILED before
      // the final attempt would flap FAILED -> RUNNING for polling clients.
      const configuredAttempts = job.opts.attempts ?? 1;
      const isFinalAttempt = job.attemptsMade + 1 >= configuredAttempts;
      this.logger.error(
        `Failed scan ${scanId} (attempt ${job.attemptsMade + 1}/${configuredAttempts}):`,
        error,
      );
      await this.scanRepository.update(scanId, {
        status: isFinalAttempt ? ScanStatus.FAILED : ScanStatus.PENDING,
      });
      throw error;
    }
  }

  /**
   * Clears previous results and marks a scan as running before processing starts.
   */
  private async resetScanResults(scanId: number): Promise<void> {
    await this.issueRepository
      .createQueryBuilder()
      .delete()
      .from(Issue)
      .where('scanId = :scanId', { scanId })
      .execute();

    await this.agentAudit.reset(scanId);

    await this.scanRepository.update(scanId, {
      status: ScanStatus.RUNNING,
      pagesDiscovered: 0,
      pagesScanned: 0,
      pagesFailed: 0,
    });
  }

  /** Persists page counters without changing the current status. */
  private async persistFinalCounters(
    scanId: number,
    progress: ScanProgress,
  ): Promise<void> {
    await this.scanRepository.update(scanId, {
      pagesDiscovered: progress.pagesDiscovered,
      pagesScanned: progress.pagesScanned,
      pagesFailed: progress.pagesFailed,
    });
  }

  /**
   * Collects trigger-filtered agent evidence from a live page into the run
   * buffer. Never throws — agent collection must not fail a page scan.
   */
  private async collectAgentEvidence(
    agent: AgentRun | undefined,
    page: Page,
    pageUrl: string,
    issues: ScannedIssue[],
  ): Promise<void> {
    if (!agent || agent.skills.length === 0) {
      return;
    }
    try {
      const units = await this.agentAudit.collectForPage(
        agent.skills,
        page,
        pageUrl,
        issues,
        agent.buffer.length,
      );
      agent.buffer.push(...units);
    } catch (error) {
      this.logger.warn(
        `Agent evidence collection failed for ${pageUrl}: ${String(error)}`,
      );
    }
  }

  /**
   * Executes single-url and url-list scans with controlled local concurrency.
   */
  private async performTargetListScan(
    scan: Scan,
    scanOptions: ScanOptions,
    agent?: AgentRun,
  ): Promise<ScanProgress> {
    const tasks: PageTask[] = this.resolveScanTargets(scan).map((url) => ({
      url,
    }));

    const progress: ScanProgress = {
      pagesDiscovered: tasks.length,
      pagesScanned: 0,
      pagesFailed: 0,
    };
    const progressWriter = this.createProgressWriter(scan.id);
    await progressWriter.flush(progress);
    const isCanceled = this.createCancellationChecker(scan.id);

    const browser = await this.browserService.getBrowser();
    const context = await this.scanner.createContext(browser, scanOptions);

    try {
      await this.processTaskQueue(
        tasks,
        this.config.crawlConcurrency,
        async (task) => {
          // Stop early if the scan was cancelled out of band.
          if (await isCanceled()) {
            return;
          }
          // Re-checked at scan time: DNS may have changed since creation.
          const policy = await this.urlPolicyService.isAllowedTarget(task.url);
          if (!policy.allowed) {
            progress.pagesFailed += 1;
            this.logger.warn(
              `Blocked page ${task.url} in scan ${scan.id}: ${policy.reason}`,
            );
            await progressWriter.maybePersist(progress);
            return;
          }
          const page = await context.newPage();
          try {
            const { issues } = await this.scanner.scanPage(
              page,
              task.url,
              scanOptions,
            );
            await this.saveIssues(scan.id, issues);
            progress.pagesScanned += 1;
            await this.collectAgentEvidence(agent, page, page.url(), issues);
          } catch (error) {
            progress.pagesFailed += 1;
            this.logger.warn(
              `Failed page ${task.url} in scan ${scan.id}: ${String(error)}`,
            );
          } finally {
            await page.close();
            await progressWriter.maybePersist(progress);
          }
        },
      );
      await progressWriter.flush(progress);
    } finally {
      await context.close();
    }

    return progress;
  }

  /**
   * Executes crawl-mode scans: uses Crawlee's {@link BasicCrawler} for URL
   * queuing, deduplication, concurrency, and retry logic while managing the
   * browser entirely through {@link BrowserService}. Links are extracted from
   * each loaded page and passed to Crawlee's native `enqueueLinks` utility,
   * which applies the strategy and glob filters before adding them to the queue.
   */
  private async performCrawl(
    scan: Scan,
    scanOptions: ScanOptions,
    agent?: AgentRun,
  ): Promise<ScanProgress> {
    const seedUrls = this.resolveScanTargets(scan);
    const maxPages = scan.crawlMaxPages ?? DEFAULT_CRAWL_OPTIONS.maxPages;
    const maxDepth = scan.crawlMaxDepth ?? DEFAULT_CRAWL_OPTIONS.maxDepth;
    const strategy =
      CRAWL_STRATEGY_TO_ENQUEUE[
        scan.crawlStrategy ?? DEFAULT_CRAWL_OPTIONS.strategy
      ];
    const globs = scan.crawlGlobs || [];
    const excludeGlobs = scan.crawlExcludeGlobs || [];
    const concurrency = this.config.crawlConcurrency;

    const seen = new Set(seedUrls);
    const crawlConfig = new Configuration({
      storageClient: new MemoryStorage({ persistStorage: false }),
    });
    const requestQueue = await RequestQueue.open(
      `scan-${scan.id}-${Date.now()}`,
      { config: crawlConfig },
    );

    const progress: ScanProgress = {
      pagesDiscovered: 0,
      pagesScanned: 0,
      pagesFailed: 0,
    };
    const progressWriter = this.createProgressWriter(scan.id);
    await progressWriter.flush(progress);
    const isCanceled = this.createCancellationChecker(scan.id);

    await requestQueue.addRequests(
      seedUrls.map((url) => ({ url, uniqueKey: url, userData: { depth: 0 } })),
    );

    const browser = await this.browserService.getBrowser();
    const context = await this.scanner.createContext(browser, scanOptions);

    const crawler = new BasicCrawler(
      {
        requestQueue,
        maxConcurrency: Math.max(1, concurrency),
        maxRequestsPerCrawl: maxPages,
        requestHandler: async ({ request, enqueueLinks }) => {
          // Stop processing further pages once cancelled; drains quietly.
          if (await isCanceled()) {
            return;
          }
          const depth = Number(request.userData.depth || 0);
          progress.pagesDiscovered += 1;
          // Discovered links are unvetted input — enforce the target policy
          // for every crawled page, not just the seeds.
          const policy = await this.urlPolicyService.isAllowedTarget(
            request.url,
          );
          if (!policy.allowed) {
            progress.pagesFailed += 1;
            this.logger.warn(
              `Blocked page ${request.url} in scan ${scan.id}: ${policy.reason}`,
            );
            await progressWriter.maybePersist(progress);
            return;
          }
          const page = await context.newPage();
          try {
            // Scan phase — failures here count as page failures.
            try {
              const { issues } = await this.scanner.scanPage(
                page,
                request.url,
                scanOptions,
              );
              await this.saveIssues(scan.id, issues);
              progress.pagesScanned += 1;
              await this.collectAgentEvidence(agent, page, page.url(), issues);
            } catch (error) {
              progress.pagesFailed += 1;
              this.logger.warn(
                `Failed page ${request.url} in scan ${scan.id}: ${String(error)}`,
              );
            }

            // Link discovery phase — non-fatal; failures do not affect counters.
            if (depth < maxDepth && seen.size < maxPages) {
              let hrefs: string[] = [];
              try {
                hrefs = await page.evaluate(() =>
                  Array.from(
                    document.querySelectorAll<HTMLAnchorElement>('a[href]'),
                  ).map((a) => a.href),
                );
              } catch (error) {
                this.logger.debug(
                  `Skipped link discovery for ${request.url} in scan ${scan.id}: ${String(error)}`,
                );
              }

              if (hrefs.length > 0) {
                await enqueueLinks({
                  urls: hrefs,
                  baseUrl: page.url(),
                  strategy,
                  globs: globs.length ? globs : undefined,
                  exclude: excludeGlobs.length ? excludeGlobs : undefined,
                  transformRequestFunction: (nextRequest) => {
                    const normalized = normalizeHttpUrl(nextRequest.url);
                    if (!normalized) return false;
                    if (seen.has(normalized)) return false;
                    if (seen.size >= maxPages) return false;

                    seen.add(normalized);
                    nextRequest.url = normalized;
                    nextRequest.uniqueKey = normalized;
                    nextRequest.userData = {
                      ...(nextRequest.userData ?? {}),
                      depth: depth + 1,
                    };
                    return nextRequest;
                  },
                });
              }
            }
          } finally {
            await page.close();
            await progressWriter.maybePersist(progress);
          }
        },
        failedRequestHandler: async ({ request }) => {
          progress.pagesFailed += 1;
          this.logger.warn(
            `Failed page ${request.url} in scan ${scan.id} after retries`,
          );
          await progressWriter.maybePersist(progress);
        },
      },
      crawlConfig,
    );

    try {
      await crawler.run();
      await progressWriter.flush(progress);
    } finally {
      await context.close();
      await requestQueue.drop().catch((error: unknown) => {
        this.logger.warn(
          `Failed to drop temporary crawl queue for scan ${scan.id}: ${String(error)}`,
        );
      });
    }

    return progress;
  }

  /**
   * Returns normalized target URLs for the scan regardless of stored shape.
   */
  private resolveScanTargets(scan: Scan): string[] {
    return normalizeAndDedupeHttpUrls(scan.targets);
  }

  /**
   * Decrypts persisted basic-auth credentials for runtime use when configured.
   */
  private resolveBasicAuth(scan: Scan): BasicAuth | undefined {
    const { basicAuthUsernameEncrypted, basicAuthPasswordEncrypted } = scan;
    if (!basicAuthUsernameEncrypted && !basicAuthPasswordEncrypted) {
      return undefined;
    }
    if (!basicAuthUsernameEncrypted || !basicAuthPasswordEncrypted) {
      throw new Error(
        `Scan ${scan.id} has incomplete encrypted basic-auth credentials`,
      );
    }

    return this.basicAuthCryptoService.decryptCredentials(
      basicAuthUsernameEncrypted,
      basicAuthPasswordEncrypted,
    );
  }

  /**
   * Runs a bounded-concurrency worker loop over an in-memory task queue.
   */
  private async processTaskQueue<T>(
    queue: T[],
    concurrency: number,
    worker: (task: T) => Promise<void>,
  ): Promise<void> {
    let cursor = 0;
    const workerCount = Math.max(1, concurrency);

    const runner = async () => {
      while (cursor < queue.length) {
        await worker(queue[cursor++]);
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runner()));
  }

  /**
   * Persists discovered issues for a scan run in bulk.
   */
  private async saveIssues(
    scanId: number,
    issues: ScannedIssue[],
  ): Promise<void> {
    if (issues.length === 0) return;

    const entities = issues.map((issue) =>
      this.issueRepository.create({
        scan: { id: scanId } as Pick<Scan, 'id'>,
        ruleId: issue.ruleId,
        description: truncate(issue.description, MAX_DESCRIPTION_LENGTH)!,
        impact: issue.impact,
        // Stored in canonical form so page-URL filters can match in SQL.
        pageUrl: issue.pageUrl
          ? (normalizeHttpUrl(issue.pageUrl) ?? issue.pageUrl)
          : issue.pageUrl,
        selector: truncate(issue.selector, MAX_SELECTOR_LENGTH),
        context: truncate(issue.context, MAX_CONTEXT_LENGTH),
        helpUrl: issue.helpUrl,
      }),
    );

    await this.issueRepository.save(entities);
  }

  /**
   * Reads the current persisted status to detect an out-of-band cancellation.
   */
  private async isCanceled(scanId: number): Promise<boolean> {
    const row = await this.scanRepository.findOne({
      where: { id: scanId },
      select: { id: true, status: true },
    });
    return row?.status === ScanStatus.CANCELED;
  }

  /**
   * Creates a per-scan cancellation checker that caches the result for a short
   * window so page loops can poll it cheaply.
   */
  private createCancellationChecker(scanId: number): () => Promise<boolean> {
    let canceled = false;
    let lastCheckAt = 0;

    return async () => {
      if (canceled) return true;
      if (Date.now() - lastCheckAt < PROGRESS_WRITE_INTERVAL_MS) {
        return false;
      }
      lastCheckAt = Date.now();
      canceled = await this.isCanceled(scanId);
      return canceled;
    };
  }

  /**
   * Creates a per-scan progress persister that batches row updates.
   *
   * Large crawls previously issued one UPDATE per scanned page; the writer
   * only hits the database every {@link PROGRESS_WRITE_PAGE_BATCH} pages or
   * {@link PROGRESS_WRITE_INTERVAL_MS} milliseconds, whichever comes first.
   */
  private createProgressWriter(scanId: number): ProgressWriter {
    let lastWriteAt = 0;
    let pagesSinceWrite = 0;

    const write = async (progress: ScanProgress): Promise<void> => {
      lastWriteAt = Date.now();
      pagesSinceWrite = 0;
      await this.scanRepository.update(scanId, { ...progress });
    };

    return {
      flush: (progress) => write(progress),
      maybePersist: async (progress) => {
        pagesSinceWrite += 1;
        if (
          Date.now() - lastWriteAt < PROGRESS_WRITE_INTERVAL_MS &&
          pagesSinceWrite < PROGRESS_WRITE_PAGE_BATCH
        ) {
          return;
        }
        await write(progress);
      },
    };
  }
}
