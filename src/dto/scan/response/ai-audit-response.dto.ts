import { ApiProperty } from '@nestjs/swagger';
import { AgentSkill } from '../../../enums/agent-skill.enum';

/**
 * Status of the optional AI-audit phase. The object is present only when the
 * audit was requested; scans that never requested it omit `aiAudit` entirely.
 * - `pending`: requested but the analyzing phase has not started.
 * - `running`: agent evaluation in progress.
 * - `completed`: agent evaluation finished with at least one work unit.
 * - `skipped`: nothing eligible to evaluate, or the scan failed/was canceled
 *   before the audit finished.
 */
export enum AiAuditStatus {
  SKIPPED = 'skipped',
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
}

/**
 * Summary of the AI-audit phase for a scan run.
 */
export class AiAuditResponseDto {
  /** Current AI-audit phase status. */
  @ApiProperty({ enum: AiAuditStatus, example: AiAuditStatus.COMPLETED })
  status: AiAuditStatus;

  /** Skills requested for this run. */
  @ApiProperty({
    enum: AgentSkill,
    isArray: true,
    example: [AgentSkill.IMAGE_ALT_TEXT],
  })
  requestedSkills: AgentSkill[];

  /** Total agent work units queued for evaluation. */
  @ApiProperty({ type: 'integer', example: 12, minimum: 0 })
  tasksTotal: number;

  /** Work units evaluated (including no-issue results). */
  @ApiProperty({ type: 'integer', example: 12, minimum: 0 })
  tasksCompleted: number;

  /** Work units that failed to evaluate. */
  @ApiProperty({ type: 'integer', example: 0, minimum: 0 })
  tasksFailed: number;
}
