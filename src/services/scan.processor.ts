import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { Job } from 'bullmq';
import {
  BasicCrawler,
  type BasicCrawlingContext,
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
  PageRejectedError,
  ScanOptions,
  ScannedIssue,
  ScopedBasicAuth,
} from './axe-accessibility-scanner.service';
import { BasicAuthCryptoService } from './basic-auth-crypto.service';
import { UrlPolicyService } from './url-policy.service';
import {
  normalizeAndDedupeHttpUrls,
  normalizeHttpUrl,
} from '../utils/url-normalization.util';
import { DEFAULT_CRAWL_OPTIONS } from '../constants/crawl-options.constants';
import {
  isWithinCrawlScope,
  resolveSeedScope,
} from '../utils/crawl-scope.util';
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

/**
 * Upper bound for one page's browser work: navigation, axe analysis, AI
 * evidence collection and link extraction. Only navigation has a timeout of
 * its own; a page whose main thread stays busy after DOMContentLoaded would
 * otherwise block the analysis forever while BullMQ keeps renewing the job's
 * lock, holding a scan slot until the API restarts. On expiry the page is
 * closed, which makes its pending Playwright calls reject, and it counts as
 * failed.
 */
export const PAGE_DEADLINE_MS = 120_000;

/**
 * Crawlee's request-handler timeout. Crawlee's timeout rejects but never stops
 * the handler, so it must not fire while the page work is still within its
 * deadline; the extra minute covers the policy check, database writes and
 * enqueueing around the page work.
 */
const CRAWL_HANDLER_TIMEOUT_SECS = PAGE_DEADLINE_MS / 1000 + 60;

/** A page's browser work outlived the page deadline; the page was closed. */
export class PageDeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

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
 * What a crawled page's browser work produced. Nothing is stored or enqueued
 * until the work finished within the page deadline.
 */
type CrawlPageOutcome =
  | {
      kind: 'scanned';
      issues: ScannedIssue[];
      units: CollectedUnit[];
      /** Link targets to follow, scoped by `scopeUrl`. */
      links: string[];
      scopeUrl: string;
    }
  | { kind: 'failed'; reason: string; links: string[]; scopeUrl: string }
  /** Not a page of this crawl (redirect alias or off-scope redirect). */
  | { kind: 'skipped'; reason: string };

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
  /** {@link PAGE_DEADLINE_MS}; an instance field so real-browser tests can shorten it. */
  private readonly pageDeadlineMs: number = PAGE_DEADLINE_MS;

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
      // A cancellation may land between reading the row above and resetting it
      // below; resetScanResults refuses to revive a CANCELED scan and reports
      // whether the run may proceed.
      if (!(await this.resetScanResults(scanId))) {
        this.logger.log(`Scan ${scanId} was canceled before processing`);
        return;
      }

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
   * Clears previous results and marks a scan as running before processing
   * starts. The status transition is guarded so a cancellation racing this
   * reset is not clobbered back to RUNNING.
   *
   * @returns `true` when the scan was moved to RUNNING; `false` when it was
   * already CANCELED (or gone) and processing should stop.
   */
  private async resetScanResults(scanId: number): Promise<boolean> {
    await this.issueRepository
      .createQueryBuilder()
      .delete()
      .from(Issue)
      .where('scanId = :scanId', { scanId })
      .execute();

    await this.agentAudit.reset(scanId);

    const result = await this.scanRepository.update(
      { id: scanId, status: Not(ScanStatus.CANCELED) },
      {
        status: ScanStatus.RUNNING,
        pagesDiscovered: 0,
        pagesScanned: 0,
        pagesFailed: 0,
      },
    );
    return (result.affected ?? 0) > 0;
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
   * Collects trigger-filtered agent evidence from a live page. Never throws —
   * agent collection must not fail a page scan.
   */
  private async collectAgentEvidence(
    agent: AgentRun | undefined,
    page: Page,
    pageUrl: string,
    issues: ScannedIssue[],
  ): Promise<CollectedUnit[]> {
    if (!agent || agent.skills.length === 0) {
      return [];
    }
    try {
      return await this.agentAudit.collectForPage(
        agent.skills,
        page,
        pageUrl,
        issues,
        agent.buffer.length,
      );
    } catch (error) {
      this.logger.warn(
        `Agent evidence collection failed for ${pageUrl}: ${String(error)}`,
      );
      return [];
    }
  }

  /** Adds collected evidence to the run buffer, clamped to the scan-wide cap. */
  private bufferAgentEvidence(
    agent: AgentRun | undefined,
    units: CollectedUnit[],
  ): void {
    if (!agent || units.length === 0) {
      return;
    }
    // Concurrent page handlers may each have read the same buffer length
    // before awaiting collection, so re-check the scan-wide cap here where the
    // push is synchronous and clamp to the room that is actually left.
    const room = this.agentAudit.remainingScanUnits(agent.buffer.length);
    if (room > 0) {
      agent.buffer.push(...units.slice(0, room));
    }
  }

  /**
   * Finishes the browser work on an analysed page: collects its AI-audit
   * evidence while the page is still live, then re-verifies the target policy
   * (collection can make the page load more, e.g. lazy images).
   *
   * @throws TargetPolicyViolationError When the page reached a blocked
   * target; nothing from it may be stored or buffered.
   */
  private async collectVerifiedEvidence(
    agent: AgentRun | undefined,
    page: Page,
    pageUrl: string,
    issues: ScannedIssue[],
  ): Promise<CollectedUnit[]> {
    const units = await this.collectAgentEvidence(agent, page, pageUrl, issues);
    await this.scanner.assertPageAllowed(page);
    return units;
  }

  /**
   * Stores the issues and buffers the evidence of a page that passed every
   * check within its deadline.
   */
  private async commitPageResults(
    scanId: number,
    agent: AgentRun | undefined,
    issues: ScannedIssue[],
    units: CollectedUnit[],
  ): Promise<void> {
    await this.saveIssues(scanId, issues);
    this.bufferAgentEvidence(agent, units);
  }

  /**
   * Runs one page's browser work under the page deadline
   * ({@link PAGE_DEADLINE_MS}). On expiry the page is closed — its pending
   * Playwright calls then reject — and a {@link PageDeadlineError} is thrown
   * without waiting for the work. Whatever the abandoned work still returns is
   * discarded, so `work` must not store, buffer or enqueue anything itself.
   */
  private async withPageDeadline<T>(
    page: Page,
    url: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const running = work();
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        void page.close().catch(() => undefined);
        reject(
          new PageDeadlineError(
            `${url} did not finish within the ${this.pageDeadlineMs / 1000} s page deadline`,
          ),
        );
      }, this.pageDeadlineMs);
    });
    try {
      return await Promise.race([running, expired]);
    } finally {
      clearTimeout(timer);
      // An abandoned run rejects once its page is closed; nobody awaits it.
      running.catch(() => undefined);
    }
  }

  /**
   * Reads the link targets of a crawled page. Non-fatal: returns none when the
   * page cannot be mined.
   */
  private async extractLinks(
    page: Page,
    url: string,
    scanId: number,
  ): Promise<string[]> {
    try {
      // The page may have reached a blocked target since its scan (timers,
      // late subresources); never mine such a page.
      await this.scanner.assertPageAllowed(page);
      return await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).map(
          (a) => a.href,
        ),
      );
    } catch (error) {
      this.logger.debug(
        `Skipped link discovery for ${url} in scan ${scanId}: ${String(error)}`,
      );
      return [];
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
            const { issues, units } = await this.withPageDeadline(
              page,
              task.url,
              async () => {
                const { finalUrl, issues } = await this.scanner.scanPage(
                  page,
                  task.url,
                  scanOptions,
                );
                const units = await this.collectVerifiedEvidence(
                  agent,
                  page,
                  finalUrl,
                  issues,
                );
                return { issues, units };
              },
            );
            await this.commitPageResults(scan.id, agent, issues, units);
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
   * queuing, deduplication and concurrency while managing the browser entirely
   * through {@link BrowserService}. Pages are never retried: a failed page
   * counts as failed, once. Links are extracted from each loaded page and
   * passed to Crawlee's native `enqueueLinks` utility, which applies the
   * strategy and glob filters before adding them to the queue.
   *
   * The strategy is applied against each seed's scope (the seed URL, or its
   * landing URL when it redirects within its own site), not against the URL a
   * page redirected to. A page whose final URL leaves that scope, or that was
   * already scanned under another URL, is skipped.
   */
  private async performCrawl(
    scan: Scan,
    scanOptions: ScanOptions,
    agent?: AgentRun,
  ): Promise<ScanProgress> {
    const seedUrls = this.resolveScanTargets(scan);
    const maxPages = scan.crawlMaxPages ?? DEFAULT_CRAWL_OPTIONS.maxPages;
    const maxDepth = scan.crawlMaxDepth ?? DEFAULT_CRAWL_OPTIONS.maxDepth;
    const crawlStrategy = scan.crawlStrategy ?? DEFAULT_CRAWL_OPTIONS.strategy;
    const strategy = CRAWL_STRATEGY_TO_ENQUEUE[crawlStrategy];
    const globs = scan.crawlGlobs || [];
    const excludeGlobs = scan.crawlExcludeGlobs || [];
    const concurrency = this.config.crawlConcurrency;

    /**
     * URLs the request queue holds (handled, in progress or pending): the
     * seeds plus every link the queue accepted. Only links that passed the
     * strategy and glob filters get here, so a link one seed's scope rejects
     * can still be followed from another seed's pages.
     */
    const queuedUrls = new Set(seedUrls);
    /** Normalized final URLs already analysed, so redirect aliases scan once. */
    const scannedFinalUrls = new Set<string>();
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

    // Counters are kept per request (Crawlee's uniqueKey, the normalized URL):
    // a request is discovered once and settled once, as scanned, failed or
    // skipped — even when Crawlee fails a request whose handler is still
    // running (after requestHandlerTimeoutSecs), and that handler finishes
    // later.
    const discoveredRequests = new Set<string>();
    const settledRequests = new Set<string>();
    const discover = (key: string): void => {
      if (discoveredRequests.has(key)) return;
      discoveredRequests.add(key);
      progress.pagesDiscovered += 1;
    };
    /** Counts the outcome of a request; false when it was already settled. */
    const settle = (
      key: string,
      outcome: 'scanned' | 'failed' | 'skipped',
    ): boolean => {
      if (settledRequests.has(key)) return false;
      settledRequests.add(key);
      if (outcome === 'scanned') progress.pagesScanned += 1;
      else if (outcome === 'failed') progress.pagesFailed += 1;
      // Like a link the strategy filters out: not a page of this crawl.
      else progress.pagesDiscovered -= 1;
      return true;
    };

    await requestQueue.addRequests(
      seedUrls.map((url) => ({ url, uniqueKey: url, userData: { depth: 0 } })),
    );

    const browser = await this.browserService.getBrowser();
    const context = await this.scanner.createContext(browser, scanOptions);

    /** Links of a page at `depth`, or none when they could not be followed. */
    const mineLinks = (page: Page, url: string, depth: number) =>
      // Every queued URL counts towards maxPages, so a full queue has no room
      // for more links.
      depth < maxDepth && queuedUrls.size < maxPages
        ? this.extractLinks(page, url, scan.id)
        : Promise.resolve([]);

    /**
     * A crawled page's browser work, run under the page deadline: navigation,
     * the crawl-scope checks, axe analysis, AI evidence collection and link
     * extraction. Stores and enqueues nothing.
     *
     * Links are scoped by the crawl's seed, never by wherever a page
     * redirected to; children inherit the scope through userData.
     */
    const inspectCrawlPage = async (
      page: Page,
      url: string,
      depth: number,
      inheritedScope: string,
    ): Promise<CrawlPageOutcome> => {
      let scopeUrl = inheritedScope;
      try {
        const { finalUrl } = await this.scanner.openPage(page, url);
        if (depth === 0) {
          // apex → www or http → https keeps the crawl on the seed's site; a
          // redirect to another site does not move it there.
          scopeUrl = resolveSeedScope(url, finalUrl);
        }
        if (!isWithinCrawlScope(finalUrl, scopeUrl, crawlStrategy)) {
          const reason = `redirected outside the crawl scope to ${finalUrl}`;
          // A seed doing so is most likely a wrong seed URL — surface it as a
          // failure. Any other page is like a link the strategy filters out.
          return depth === 0
            ? { kind: 'failed', reason, links: [], scopeUrl }
            : { kind: 'skipped', reason };
        }
        const finalKey = normalizeHttpUrl(finalUrl) ?? finalUrl;
        if (scannedFinalUrls.has(finalKey)) {
          // Another URL already redirected to this page.
          return { kind: 'skipped', reason: `already scanned as ${finalKey}` };
        }
        scannedFinalUrls.add(finalKey);
        const { issues } = await this.scanner.analyzeLoadedPage(
          page,
          scanOptions,
          finalUrl,
        );
        const units = await this.collectVerifiedEvidence(
          agent,
          page,
          finalUrl,
          issues,
        );
        const links = await mineLinks(page, url, depth);
        return { kind: 'scanned', issues, units, links, scopeUrl };
      } catch (error) {
        // A rejected page (an HTTP error page, or one that reached a blocked
        // target) is not site content: its links are not followed either.
        const links =
          error instanceof PageRejectedError
            ? []
            : await mineLinks(page, url, depth);
        return { kind: 'failed', reason: String(error), links, scopeUrl };
      }
    };

    /** Hands a page's links to Crawlee, each URL at most once per crawl. */
    const enqueueNewLinks = async (
      enqueueLinks: BasicCrawlingContext['enqueueLinks'],
      hrefs: string[],
      scopeUrl: string,
      depth: number,
    ): Promise<void> => {
      // Offer each link once: Crawlee adds already-queued URLs in batches
      // sized to the remaining page budget and sleeps a second between
      // batches, so re-offering a site's navigation on every page would stall
      // a nearly full crawl.
      const links = normalizeAndDedupeHttpUrls(hrefs).filter(
        (link) => !queuedUrls.has(link),
      );
      if (links.length === 0) {
        return;
      }
      // Crawlee filters by strategy and globs after this transform and caps
      // the additions at the remaining maxRequestsPerCrawl budget, so the
      // transform must not spend any budget itself.
      const { processedRequests } = await enqueueLinks({
        urls: links,
        baseUrl: scopeUrl,
        userData: { scopeUrl },
        strategy,
        globs: globs.length ? globs : undefined,
        exclude: excludeGlobs.length ? excludeGlobs : undefined,
        transformRequestFunction: (nextRequest) => {
          const normalized = normalizeHttpUrl(nextRequest.url);
          if (!normalized) return false;
          nextRequest.url = normalized;
          nextRequest.uniqueKey = normalized;
          nextRequest.userData = {
            ...(nextRequest.userData ?? {}),
            depth: depth + 1,
          };
          return nextRequest;
        },
      });
      for (const { uniqueKey } of processedRequests) {
        queuedUrls.add(uniqueKey);
      }
    };

    const crawler = new BasicCrawler(
      {
        requestQueue,
        maxConcurrency: Math.max(1, concurrency),
        maxRequestsPerCrawl: maxPages,
        // Scan errors are handled inside the handler; anything escaping it
        // (e.g. a lost browser) would fail the same way again. A retry would
        // also run alongside a timed-out handler, which Crawlee cannot stop.
        maxRequestRetries: 0,
        requestHandlerTimeoutSecs: CRAWL_HANDLER_TIMEOUT_SECS,
        requestHandler: async ({ request, enqueueLinks }) => {
          // Stop processing further pages once cancelled; drains quietly.
          if (await isCanceled()) {
            return;
          }
          const key = request.uniqueKey;
          const depth = Number(request.userData.depth || 0);
          discover(key);
          // Discovered links are unvetted input — enforce the target policy
          // for every crawled page, not just the seeds.
          const policy = await this.urlPolicyService.isAllowedTarget(
            request.url,
          );
          if (!policy.allowed) {
            settle(key, 'failed');
            this.logger.warn(
              `Blocked page ${request.url} in scan ${scan.id}: ${policy.reason}`,
            );
            await progressWriter.maybePersist(progress);
            return;
          }
          const inheritedScope =
            typeof request.userData.scopeUrl === 'string'
              ? request.userData.scopeUrl
              : request.url;
          const page = await context.newPage();
          try {
            const outcome = await this.withPageDeadline(page, request.url, () =>
              inspectCrawlPage(page, request.url, depth, inheritedScope),
            ).catch(
              (error: unknown): CrawlPageOutcome => ({
                kind: 'failed',
                reason: String(error),
                links: [],
                scopeUrl: inheritedScope,
              }),
            );

            if (settledRequests.has(key)) {
              // Crawlee already failed this request (handler timeout), or a
              // second run of it got here: its result is not used.
              this.logger.debug(
                `Discarded a late result for ${request.url} in scan ${scan.id}`,
              );
              return;
            }
            if (outcome.kind === 'skipped') {
              settle(key, 'skipped');
              this.logger.debug(
                `Skipped ${request.url} in scan ${scan.id}: ${outcome.reason}`,
              );
              return;
            }
            if (outcome.kind === 'scanned') {
              try {
                await this.commitPageResults(
                  scan.id,
                  agent,
                  outcome.issues,
                  outcome.units,
                );
                settle(key, 'scanned');
              } catch (error) {
                settle(key, 'failed');
                this.logger.warn(
                  `Failed page ${request.url} in scan ${scan.id}: ${String(error)}`,
                );
              }
            } else {
              settle(key, 'failed');
              this.logger.warn(
                `Failed page ${request.url} in scan ${scan.id}: ${outcome.reason}`,
              );
            }

            await enqueueNewLinks(
              enqueueLinks,
              outcome.links,
              outcome.scopeUrl,
              depth,
            );
          } finally {
            await page.close();
            await progressWriter.maybePersist(progress);
          }
        },
        // The handler threw or exceeded requestHandlerTimeoutSecs.
        failedRequestHandler: async ({ request }, error) => {
          discover(request.uniqueKey);
          if (!settle(request.uniqueKey, 'failed')) return;
          this.logger.warn(
            `Failed page ${request.url} in scan ${scan.id}: ${String(error)}`,
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
   * Decrypts persisted basic-auth credentials for runtime use when configured,
   * scoped to the origin of the scan's first target: the browser answers Basic
   * challenges from that origin only, never from other hosts the scanned pages
   * load from or redirect to.
   */
  private resolveBasicAuth(scan: Scan): ScopedBasicAuth | undefined {
    const { basicAuthUsernameEncrypted, basicAuthPasswordEncrypted } = scan;
    if (!basicAuthUsernameEncrypted && !basicAuthPasswordEncrypted) {
      return undefined;
    }
    if (!basicAuthUsernameEncrypted || !basicAuthPasswordEncrypted) {
      throw new Error(
        `Scan ${scan.id} has incomplete encrypted basic-auth credentials`,
      );
    }

    const targets = this.resolveScanTargets(scan);
    if (targets.length === 0) {
      return undefined;
    }
    const origin = new URL(targets[0]).origin;
    const otherOrigins = new Set(
      targets
        .map((target) => new URL(target).origin)
        .filter((targetOrigin) => targetOrigin !== origin),
    );
    if (otherOrigins.size > 0) {
      this.logger.warn(
        `Scan ${scan.id}: Basic Auth credentials are only sent to ${origin}; ` +
          `targets on ${[...otherOrigins].join(', ')} are loaded without them`,
      );
    }

    return {
      ...this.basicAuthCryptoService.decryptCredentials(
        basicAuthUsernameEncrypted,
        basicAuthPasswordEncrypted,
      ),
      origin,
    };
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
