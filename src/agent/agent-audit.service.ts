import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Page } from 'playwright';
import { Scan } from '../entities/scan.entity';
import { AgentFinding } from '../entities/agent-finding.entity';
import { agentConfig } from '../config/configuration';
import { truncate } from '../utils/truncate.util';
import type { ScannedIssue } from '../services/axe-accessibility-scanner.service';
import { AgentHarnessService } from './harness/agent-harness.service';
import { SkillRegistry } from './skills/skill-registry';
import type {
  AgentFindingDraft,
  AuditSkill,
  Evidence,
} from './skills/audit-skill.interface';

/** Length caps for persisted finding fields. */
const MAX_MESSAGE_LENGTH = 2000;
const MAX_SUGGESTION_LENGTH = 1000;
const MAX_SELECTOR_LENGTH = 1000;

/** Page-scoped options of an evidence collection. */
export interface CollectOptions {
  /** CSS selector the scan is limited to (`scanOptions.rootElement`). */
  rootElement?: string;
  /**
   * Time (epoch ms) by which collection must be done; the units collected by
   * then are returned. Absent: no time limit.
   */
  deadline?: number;
}

/**
 * Resolves with the result of `work`, or with `undefined` once `ms` passed
 * first. An abandoned `work` may still reject later; that is ignored.
 */
async function withinTime<T>(
  work: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  if (!Number.isFinite(ms)) {
    return work;
  }
  work.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** A collected work unit paired with the skill that produced it. */
export interface CollectedUnit {
  skill: AuditSkill;
  evidence: Evidence;
}

/**
 * Orchestrates the optional LLM-agent audit phase for a scan.
 *
 * Collection is page-bound (called from the scan processor while a page is
 * live) and already trigger-filtered against axe findings. Evaluation runs
 * after the page loop: it fans out one structured request per unit with a
 * concurrency cap, persists problem findings, and updates the scan's AI-task
 * counters. Spend is bounded up front by the unit caps and the per-request
 * output-token cap, so no separate token budget is enforced here.
 */
@Injectable()
export class AgentAuditService {
  private readonly logger = new Logger(AgentAuditService.name);

  constructor(
    @InjectRepository(AgentFinding)
    private readonly findingRepository: Repository<AgentFinding>,
    @InjectRepository(Scan)
    private readonly scanRepository: Repository<Scan>,
    private readonly registry: SkillRegistry,
    private readonly harness: AgentHarnessService,
    @Inject(agentConfig.KEY)
    private readonly config: ConfigType<typeof agentConfig>,
  ) {}

  /** Whether the AI audit capability is enabled server-side. */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Clears prior agent findings and zeroes AI-task counters so a re-run
   * (BullMQ retry) starts clean.
   */
  async reset(scanId: number): Promise<void> {
    await this.findingRepository
      .createQueryBuilder()
      .delete()
      .from(AgentFinding)
      .where('scanId = :scanId', { scanId })
      .execute();
    await this.scanRepository.update(scanId, {
      aiTasksTotal: 0,
      aiTasksCompleted: 0,
      aiTasksFailed: 0,
    });
  }

  /**
   * Resolves the skills to run for a scan: empty unless the feature and scan
   * mode are enabled and the scan requested one or more whitelisted skills.
   */
  resolveSkills(scan: Scan): AuditSkill[] {
    if (!this.config.enabled || !scan.aiAuditSkills?.length) {
      return [];
    }
    if (!this.config.allowedScanModes.includes(scan.mode)) {
      this.logger.warn(
        `Skipping AI audit for scan ${scan.id}: scan mode '${scan.mode}' is not allowed by AGENT_ALLOWED_SCAN_MODES.`,
      );
      return [];
    }
    return this.registry.resolve(scan.aiAuditSkills, this.config.allowedSkills);
  }

  /**
   * Units still collectable for a scan given how many are already buffered.
   * Never negative. Used by the page loop to clamp concurrent pushes to the
   * scan-wide cap where the check-and-append is synchronous.
   */
  remainingScanUnits(collectedSoFar: number): number {
    return Math.max(0, this.config.maxUnitsPerScan - collectedSoFar);
  }

  /**
   * Collects trigger-filtered work units from a live page across all active
   * skills. Both the per-scan unit budget and the per-page cap are shared
   * across every skill on the page, so the skills together never exceed either.
   *
   * Page skills (one unit each) are collected first and their units lead the
   * result; element skills share what is left. Otherwise a page with more
   * images than the cap would leave no room for the page skills, and the
   * scan-wide clamp, which drops trailing units, would always drop them.
   *
   * With `options.deadline`, collection resolves by that time with the units
   * of the skills that finished: a skill still collecting then is abandoned
   * (its page is closed later, which ends it), and later skills do not start.
   */
  async collectForPage(
    skills: AuditSkill[],
    page: Page,
    pageUrl: string,
    axeIssues: ScannedIssue[],
    collectedSoFar: number,
    options: CollectOptions = {},
  ): Promise<CollectedUnit[]> {
    const remaining = this.remainingScanUnits(collectedSoFar);
    // The tightest cap that applies to this page: whichever of the scan-wide
    // remainder and the per-page cap is smaller. Shared across all skills.
    const cap = Math.min(remaining, this.config.maxUnitsPerPage);
    if (skills.length === 0 || cap <= 0) {
      return [];
    }

    const pageSkills = skills.filter((skill) => skill.granularity === 'page');
    const elementSkills = skills.filter(
      (skill) => skill.granularity !== 'page',
    );

    const timeLeft = (): number =>
      options.deadline === undefined ? Infinity : options.deadline - Date.now();

    const units: CollectedUnit[] = [];
    for (const skill of [...pageSkills, ...elementSkills]) {
      const budgetLeft = cap - units.length;
      if (budgetLeft <= 0) break;
      if (timeLeft() <= 0) {
        this.logger.warn(
          `AI evidence collection on ${pageUrl} ran out of time before skill ${skill.id}`,
        );
        break;
      }
      try {
        const evidence = await withinTime(
          skill.collect(page, {
            pageUrl,
            axeIssues,
            remainingUnits: budgetLeft,
            maxUnitsPerPage: budgetLeft,
            maxImageBytes: this.config.maxImageBytes,
            rootElement: options.rootElement,
            deadline: options.deadline,
          }),
          timeLeft(),
        );
        if (evidence === undefined) {
          this.logger.warn(
            `Skill ${skill.id} did not finish collecting on ${pageUrl} within the AI evidence time budget`,
          );
          break;
        }
        for (const item of evidence) {
          units.push({ skill, evidence: item });
          if (units.length >= cap) break;
        }
      } catch (error) {
        this.logger.warn(
          `Skill ${skill.id} collect failed on ${pageUrl}: ${String(error)}`,
        );
      }
    }
    return units;
  }

  /**
   * Evaluates all collected units: fans out structured requests with a
   * concurrency cap, persists problem findings, and records task counters. A
   * unit whose request fails counts as failed and stores nothing. Stops early
   * when cancellation is observed. Token usage is summed only for
   * the log line — the unit caps and per-request output-token cap already bound
   * total spend.
   *
   * An error outside a unit (the cancellation check's database read) fails
   * the audit: the other workers start no further unit, and the method
   * rejects only once they have finished the units they had started, so no
   * request or write of this run outlives it into a retry.
   */
  async evaluate(
    scan: Scan,
    units: CollectedUnit[],
    isCanceled: () => Promise<boolean>,
  ): Promise<void> {
    if (units.length === 0) {
      return;
    }

    await this.scanRepository.update(scan.id, {
      aiTasksTotal: units.length,
      aiTasksCompleted: 0,
      aiTasksFailed: 0,
    });

    let index = 0;
    let completed = 0;
    let failed = 0;
    let tokensSpent = 0;
    /** Set on cancellation, or when a worker failed outside a unit. */
    let stopped = false;

    const evaluateUnit = async (unit: CollectedUnit): Promise<void> => {
      try {
        const drafts = await unit.skill.evaluate(unit.evidence, this.harness);
        for (const draft of drafts) {
          // Usage is attributed to one draft per request (see AuditSkill),
          // so summing across the array counts each request's tokens once.
          tokensSpent += draft.usage.inputTokens + draft.usage.outputTokens;
        }
        await this.persist(
          scan.id,
          drafts.filter((draft) => draft.category !== 'appropriate'),
        );
        completed++;
      } catch (error) {
        // Nothing is stored for the unit: it was not checked.
        failed++;
        this.logger.warn(
          `Skill ${unit.skill.id} could not evaluate a unit on ${unit.evidence.pageUrl}: ${String(error)}`,
        );
      }
    };

    const worker = async (): Promise<void> => {
      try {
        while (!stopped) {
          const i = index++;
          if (i >= units.length) return;
          if (await isCanceled()) {
            stopped = true;
            return;
          }
          // Another worker may have failed during the check.
          if (stopped) return;
          await evaluateUnit(units[i]);
        }
      } catch (error) {
        stopped = true;
        throw error;
      }
    };

    const poolSize = Math.min(this.config.concurrency, units.length);
    const outcomes = await Promise.allSettled(
      Array.from({ length: poolSize }, () => worker()),
    );
    const failure = outcomes.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === 'rejected',
    );
    if (failure) {
      throw failure.reason;
    }

    await this.scanRepository.update(scan.id, {
      aiTasksCompleted: completed,
      aiTasksFailed: failed,
    });
    this.logger.log(
      `AI audit for scan ${scan.id}: ${completed} evaluated, ${failed} failed, ~${tokensSpent} tokens.`,
    );
  }

  /** Persists a unit's problem drafts as AgentFinding rows, atomically. */
  private async persist(
    scanId: number,
    drafts: AgentFindingDraft[],
  ): Promise<void> {
    if (drafts.length === 0) {
      return;
    }
    // One save is one transaction: a unit's findings are stored all or none,
    // so a unit counted failed never leaves part of its findings behind.
    await this.findingRepository.save(
      drafts.map((draft) => this.toFinding(scanId, draft)),
    );
  }

  /** Builds the AgentFinding row of one finding draft. */
  private toFinding(scanId: number, draft: AgentFindingDraft): AgentFinding {
    return this.findingRepository.create({
      scan: { id: scanId } as Scan,
      skill: draft.skill,
      pageUrl: draft.pageUrl,
      selector: truncate(draft.selector, MAX_SELECTOR_LENGTH),
      category: draft.category,
      wcag: draft.wcag ?? undefined,
      severity: draft.severity,
      confidence: draft.confidence,
      needsHumanReview: draft.needsHumanReview ?? false,
      message: truncate(draft.message, MAX_MESSAGE_LENGTH) ?? '',
      suggestion: truncate(draft.suggestion, MAX_SUGGESTION_LENGTH),
      details: draft.details ?? null,
      model: draft.model ?? this.config.model ?? undefined,
      inputTokens: draft.usage.inputTokens,
      outputTokens: draft.usage.outputTokens,
    });
  }
}
