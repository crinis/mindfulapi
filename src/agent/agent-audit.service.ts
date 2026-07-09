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
 * concurrency cap and a per-scan token budget, persists problem findings, and
 * updates the scan's AI-task counters.
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
   * Resolves the skills to run for a scan: empty unless the feature is enabled
   * and the scan requested one or more whitelisted skills.
   */
  resolveSkills(scan: Scan): AuditSkill[] {
    if (!this.config.enabled || !scan.aiAuditSkills?.length) {
      return [];
    }
    return this.registry.resolve(scan.aiAuditSkills, this.config.allowedSkills);
  }

  /**
   * Collects trigger-filtered work units from a live page across all active
   * skills, honoring the per-scan unit budget.
   */
  async collectForPage(
    skills: AuditSkill[],
    page: Page,
    pageUrl: string,
    axeIssues: ScannedIssue[],
    collectedSoFar: number,
  ): Promise<CollectedUnit[]> {
    const remaining = this.config.maxUnitsPerScan - collectedSoFar;
    if (skills.length === 0 || remaining <= 0) {
      return [];
    }

    const units: CollectedUnit[] = [];
    for (const skill of skills) {
      const budgetLeft = remaining - units.length;
      if (budgetLeft <= 0) break;
      try {
        const evidence = await skill.collect(page, {
          pageUrl,
          axeIssues,
          remainingUnits: budgetLeft,
          maxUnitsPerPage: this.config.maxUnitsPerPage,
          maxImageBytes: this.config.maxImageBytes,
        });
        for (const item of evidence) {
          units.push({ skill, evidence: item });
          if (units.length >= remaining) break;
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
   * concurrency cap, enforces the token budget, persists problem findings, and
   * records task counters. Stops early when cancellation is observed.
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

    const budget = this.config.tokenBudgetPerScan;
    let index = 0;
    let completed = 0;
    let failed = 0;
    let tokensSpent = 0;
    let canceled = false;

    const worker = async (): Promise<void> => {
      while (true) {
        if (canceled) return;
        const i = index++;
        if (i >= units.length) return;

        if (budget > 0 && tokensSpent >= budget) {
          failed++;
          continue;
        }
        if (await isCanceled()) {
          canceled = true;
          return;
        }

        const unit = units[i];
        try {
          const drafts = await unit.skill.evaluate(unit.evidence, this.harness);
          for (const draft of drafts) {
            // Usage is attributed to one draft per request (see AuditSkill),
            // so summing across the array counts each request's tokens once.
            tokensSpent += draft.usage.inputTokens + draft.usage.outputTokens;
            if (draft.category !== 'appropriate') {
              await this.persist(scan.id, draft);
            }
          }
          completed++;
        } catch (error) {
          failed++;
          this.logger.warn(
            `Skill ${unit.skill.id} evaluate failed: ${String(error)}`,
          );
        }
      }
    };

    const poolSize = Math.min(this.config.concurrency, units.length);
    await Promise.all(Array.from({ length: poolSize }, () => worker()));

    await this.scanRepository.update(scan.id, {
      aiTasksCompleted: completed,
      aiTasksFailed: failed,
    });
    this.logger.log(
      `AI audit for scan ${scan.id}: ${completed} evaluated, ${failed} failed, ~${tokensSpent} tokens.`,
    );
  }

  /** Persists one finding draft as an AgentFinding row. */
  private async persist(
    scanId: number,
    draft: AgentFindingDraft,
  ): Promise<void> {
    const finding = this.findingRepository.create({
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
    await this.findingRepository.save(finding);
  }
}
