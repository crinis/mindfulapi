import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from 'bullmq';
import { EnqueueStrategy, PlaywrightCrawler, RequestQueue } from 'crawlee';
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
import { compileRegexPatterns } from '../utils/regex.util';
import { DEFAULT_CRAWL_OPTIONS } from '../constants/crawl-options.constants';

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
      await this.processTaskQueue(
        tasks,
        DEFAULT_CRAWL_OPTIONS.concurrency,
        async (task) => {
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
        },
      );
    } finally {
      await context.close();
    }

    return progress;
  }

  /**
   * Executes crawl-mode scans using Crawlee and analyzes each discovered page once.
   */
  private async performCrawl(
    scan: Scan,
    scanOptions: ScanOptions,
  ): Promise<ScanProgress> {
    const seedUrls = this.resolveScanTargets(scan);
    const maxPages = scan.crawlMaxPages ?? DEFAULT_CRAWL_OPTIONS.maxPages;
    const maxDepth = scan.crawlMaxDepth ?? DEFAULT_CRAWL_OPTIONS.maxDepth;
    const sameHostOnly =
      scan.crawlSameHostOnly ?? DEFAULT_CRAWL_OPTIONS.sameHostOnly;
    const concurrency =
      scan.crawlConcurrency ?? DEFAULT_CRAWL_OPTIONS.concurrency;
    const includePatterns = compileRegexPatterns(
      scan.crawlIncludePatterns || [],
      'includePatterns',
    );
    const excludePatterns = compileRegexPatterns(
      scan.crawlExcludePatterns || [],
      'excludePatterns',
    );

    const seen = new Set(seedUrls);
    const requestQueue = await RequestQueue.open(
      `scan-${scan.id}-${Date.now()}`,
    );

    const progress: ScanProgress = {
      pagesDiscovered: seen.size,
      pagesScanned: 0,
      pagesFailed: 0,
    };
    await this.persistProgress(scan.id, progress);

    await requestQueue.addRequests(
      seedUrls.map((url) => ({ url, uniqueKey: url, userData: { depth: 0 } })),
    );

    const crawler = new PlaywrightCrawler({
      requestQueue,
      maxConcurrency: Math.max(1, concurrency),
      maxRequestsPerCrawl: maxPages,
      requestHandler: async ({ page, request, enqueueLinks }) => {
        const depth = Number(request.userData.depth || 0);
        const loadedUrl = request.loadedUrl || page.url() || request.url;
        const normalizedLoaded = normalizeHttpUrl(loadedUrl) || loadedUrl;

        if (!seen.has(normalizedLoaded)) {
          seen.add(normalizedLoaded);
          progress.pagesDiscovered = seen.size;
        }

        const { issues } = await this.scanner.analyzeLoadedPage(
          page,
          scanOptions,
          normalizedLoaded,
        );
        await this.saveIssues(scan.id, issues);
        progress.pagesScanned += 1;

        if (depth < maxDepth && seen.size < maxPages) {
          await enqueueLinks({
            strategy: sameHostOnly
              ? EnqueueStrategy.SameHostname
              : EnqueueStrategy.All,
            regexps: includePatterns.length ? includePatterns : undefined,
            exclude: excludePatterns.length ? excludePatterns : undefined,
            transformRequestFunction: (nextRequest) => {
              const normalized = normalizeHttpUrl(nextRequest.url);
              if (!normalized) return false;
              if (seen.has(normalized)) return false;
              if (seen.size >= maxPages) return false;

              seen.add(normalized);
              progress.pagesDiscovered = seen.size;
              nextRequest.url = normalized;
              nextRequest.uniqueKey = normalized;
              nextRequest.userData = {
                ...(nextRequest.userData || {}),
                depth: depth + 1,
              };
              return nextRequest;
            },
          });
        }

        await this.persistProgress(scan.id, progress);
      },
      failedRequestHandler: async ({ request }) => {
        progress.pagesFailed += 1;
        this.logger.warn(
          `Failed page ${request.url} in crawl scan ${scan.id} after retries`,
        );
        await this.persistProgress(scan.id, progress);
      },
    });

    try {
      await crawler.run();
    } finally {
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
      while (true) {
        const currentIndex = cursor;
        cursor += 1;
        if (currentIndex >= queue.length) return;
        await worker(queue[currentIndex]);
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
