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
import { Scan } from '../entities/scan.entity';
import { Issue } from '../entities/issue.entity';
import { ScanStatus } from '../enums/scan-status.enum';
import { ScanMode } from '../enums/scan-mode.enum';
import { ScanJobData } from './scan-queue.service';
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
import { truncate } from '../utils/truncate.util';

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
@Injectable()
@Processor('scan-processing')
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

      const progress =
        scan.mode === ScanMode.CRAWL
          ? await this.performCrawl(scan, scanOptions)
          : await this.performTargetListScan(scan, scanOptions);

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

    await this.scanRepository.update(scanId, {
      status: ScanStatus.RUNNING,
      pagesDiscovered: 0,
      pagesScanned: 0,
      pagesFailed: 0,
    });
  }

  /**
   * Executes single-url and url-list scans with controlled local concurrency.
   */
  private async performTargetListScan(
    scan: Scan,
    scanOptions: ScanOptions,
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

    const browser = await this.browserService.getBrowser();
    const context = await this.scanner.createContext(browser, scanOptions);

    try {
      await this.processTaskQueue(
        tasks,
        this.config.crawlConcurrency,
        async (task) => {
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
  ): Promise<ScanProgress> {
    const seedUrls = this.resolveScanTargets(scan);
    const maxPages = scan.crawlMaxPages ?? DEFAULT_CRAWL_OPTIONS.maxPages;
    const maxDepth = scan.crawlMaxDepth ?? DEFAULT_CRAWL_OPTIONS.maxDepth;
    const strategy = (scan.crawlStrategy ??
      DEFAULT_CRAWL_OPTIONS.strategy) as unknown as EnqueueStrategy;
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
