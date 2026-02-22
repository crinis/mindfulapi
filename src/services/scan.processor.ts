import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
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
  ScanOptions,
  ScannedIssue,
} from './axe-accessibility-scanner.service';
import {
  normalizeAndDedupeHttpUrls,
  normalizeHttpUrl,
} from '../utils/url-normalization.util';
import { DEFAULT_CRAWL_OPTIONS } from '../constants/crawl-options.constants';

/** Default concurrent page limit for both crawl and url_list modes. */
const DEFAULT_CONCURRENCY = 4;

/**
 * Reads the `CRAWL_CONCURRENCY` environment variable and clamps it to [1, 16].
 * Falls back to {@link DEFAULT_CONCURRENCY} when the variable is absent or invalid.
 */
function resolveConcurrency(): number {
  const raw = parseInt(process.env.CRAWL_CONCURRENCY ?? '', 10);
  if (Number.isFinite(raw) && raw >= 1) {
    return Math.min(raw, 16);
  }
  return DEFAULT_CONCURRENCY;
}

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
    const scan = await this.scanRepository.findOne({ where: { id: scanId } });

    if (!scan) {
      throw new Error(`Scan ${scanId} not found`);
    }

    this.logger.log(`Processing scan ${scanId} in mode ${scan.mode}`);

    try {
      await this.resetScanResults(scanId);

      const scanOptions: ScanOptions = {
        rootElement: scan.rootElement || undefined,
        ruleIds: scan.ruleIds?.length ? scan.ruleIds : undefined,
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
      this.logger.error(`Failed scan ${scanId}:`, error);
      await this.scanRepository.update(scanId, { status: ScanStatus.FAILED });
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
    await this.persistProgress(scan.id, progress);

    const browser = await this.browserService.getBrowser();
    const context = await this.scanner.createContext(browser, scanOptions);

    try {
      await this.processTaskQueue(tasks, resolveConcurrency(), async (task) => {
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
          await this.persistProgress(scan.id, progress);
        }
      });
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
      DEFAULT_CRAWL_OPTIONS.strategy) as EnqueueStrategy;
    const globs = scan.crawlGlobs || [];
    const excludeGlobs = scan.crawlExcludeGlobs || [];
    const concurrency = resolveConcurrency();

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
    await this.persistProgress(scan.id, progress);

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
            await this.persistProgress(scan.id, progress);
          }
        },
        failedRequestHandler: async ({ request }) => {
          progress.pagesFailed += 1;
          this.logger.warn(
            `Failed page ${request.url} in scan ${scan.id} after retries`,
          );
          await this.persistProgress(scan.id, progress);
        },
      },
      crawlConfig,
    );

    try {
      await crawler.run();
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
    return normalizeAndDedupeHttpUrls(scan.targets || [scan.url]);
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
        description: issue.description,
        impact: issue.impact,
        pageUrl: issue.pageUrl,
        selector: issue.selector,
        context: issue.context,
        helpUrl: issue.helpUrl,
      }),
    );

    await this.issueRepository.save(entities);
  }

  /**
   * Persists current progress counters to the scan row.
   */
  private async persistProgress(
    scanId: number,
    progress: ScanProgress,
  ): Promise<void> {
    await this.scanRepository.update(scanId, progress);
  }
}
