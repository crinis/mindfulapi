import { ApiProperty } from '@nestjs/swagger';
import { IssueImpact } from '../../../enums/issue-impact.enum';
import { IssueResponseDto } from './issue-response.dto';
import { RuleResponseDto } from './rule-response.dto';

/**
 * Grouped accessibility violation keyed by rule and impact.
 */
export class ViolationResponseDto {
  /** Rule metadata shared by all issue occurrences in this group. */
  @ApiProperty({ type: () => RuleResponseDto })
  rule: RuleResponseDto;

  /** Severity level for all issues in this grouped violation. */
  @ApiProperty({
    enum: IssueImpact,
    example: IssueImpact.SERIOUS,
    description: 'Severity of the violation as reported by axe-core.',
  })
  impact: IssueImpact;

  /** Individual issue occurrences belonging to this rule+impact pair. */
  @ApiProperty({
    type: () => IssueResponseDto,
    isArray: true,
    minItems: 1,
    description: 'Issue occurrences for this rule+impact pair.',
  })
  issues: IssueResponseDto[];
}
