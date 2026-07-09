import { ApiProperty } from '@nestjs/swagger';
import { AgentSkill } from '../../../enums/agent-skill.enum';
import { IssueImpact } from '../../../enums/issue-impact.enum';

/**
 * A single finding produced by the LLM-agent audit, complementing the
 * deterministic axe-core `violations`.
 */
export class AgentFindingResponseDto {
  /** Skill that produced this finding. */
  @ApiProperty({ enum: AgentSkill, example: AgentSkill.IMAGE_ALT_TEXT })
  skill: AgentSkill;

  /** Fixed per-skill verdict category (e.g. `redundant`, `inaccurate`). */
  @ApiProperty({ example: 'redundant', description: 'Per-skill verdict.' })
  category: string;

  /** WCAG success criterion the finding maps to (consistent across skills). */
  @ApiProperty({
    nullable: true,
    example: '1.1.1',
    description: 'WCAG success criterion this finding maps to.',
  })
  wcag: string | null;

  /** Severity on the shared axe impact scale. */
  @ApiProperty({ enum: IssueImpact, example: IssueImpact.MODERATE })
  severity: IssueImpact;

  /** Model-reported confidence in the verdict, 0–1. */
  @ApiProperty({ type: 'number', example: 0.82, minimum: 0, maximum: 1 })
  confidence: number;

  /** Whether a human should confirm this verdict (low confidence/unjudgeable). */
  @ApiProperty({
    type: 'boolean',
    example: false,
    description: 'True when the finding is low-confidence and needs review.',
  })
  needsHumanReview: boolean;

  /** URL of the page the finding relates to. */
  @ApiProperty({
    nullable: true,
    example: 'https://example.com',
    description: 'Page the finding was found on.',
  })
  pageUrl: string | null;

  /** CSS selector for the evaluated element, when applicable. */
  @ApiProperty({ nullable: true, example: 'img.hero' })
  selector: string | null;

  /** Human-readable description of the problem (present on every finding). */
  @ApiProperty({
    example: 'The alt text repeats the adjacent caption verbatim.',
    description:
      'Human-readable problem description, consistent across skills.',
  })
  message: string;

  /** Concrete remediation suggestion (e.g. proposed alt text), when offered. */
  @ApiProperty({ nullable: true, example: 'Team celebrating a product launch' })
  suggestion: string | null;

  /** Skill-specific structured payload for richer client rendering. */
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'Skill-specific details (e.g. needsHumanReview flag).',
  })
  details: Record<string, unknown> | null;

  /** Model identifier that produced this finding (provenance). */
  @ApiProperty({ nullable: true, example: 'gpt-4o-mini' })
  model: string | null;
}
