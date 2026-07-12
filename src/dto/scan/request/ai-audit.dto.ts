import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsEnum,
  ValidateIf,
} from 'class-validator';
import { AgentSkill } from '../../../enums/agent-skill.enum';

/**
 * Opt-in request for the optional LLM-agent audit. Present only when a client
 * wants agentic skills to run in addition to axe-core; the server must have the
 * feature enabled and each requested skill must be whitelisted.
 */
export class AiAuditRequestDto {
  /** Audit skills to run for this scan. */
  @ApiPropertyOptional({
    enum: AgentSkill,
    isArray: true,
    example: [AgentSkill.IMAGE_ALT_TEXT],
    uniqueItems: true,
    minItems: 1,
    description:
      'Agent audit skills to run in addition to axe-core. Omit to run every skill enabled server-side.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsEnum(AgentSkill, { each: true })
  skills?: AgentSkill[];
}
