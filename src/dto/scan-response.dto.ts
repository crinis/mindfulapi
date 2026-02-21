import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ScanStatus } from '../enums/scan-status.enum';
import { IssueImpact } from '../enums/issue-impact.enum';

export class IssueResponseDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiPropertyOptional({
    example: '.btn-primary',
    description: 'CSS selector identifying the element with the issue',
  })
  selector?: string;

  @ApiPropertyOptional({
    example: '<button class="btn-primary">Submit</button>',
    description: 'HTML snippet of the problematic element',
  })
  context?: string;
}

export class RuleResponseDto {
  @ApiProperty({
    example: 'color-contrast',
    description: 'Axe rule identifier',
  })
  id: string;

  @ApiProperty({ example: 'Elements must have sufficient color contrast' })
  description: string;

  @ApiPropertyOptional({
    example:
      'https://dequeuniversity.com/rules/axe/4.11/color-contrast?application=axeAPI',
    description: 'Link to remediation guidance on Deque University',
  })
  helpUrl?: string;

  @ApiPropertyOptional({
    example: ['wcag2aa', 'wcag143', 'cat.color'],
    description: 'WCAG and category tags for this rule',
  })
  tags?: string[];
}

export class ViolationResponseDto {
  @ApiProperty({ type: () => RuleResponseDto })
  rule: RuleResponseDto;

  @ApiProperty({
    enum: IssueImpact,
    example: IssueImpact.SERIOUS,
    description: 'Severity of the violation as reported by axe-core',
  })
  impact: IssueImpact;

  @ApiProperty({ type: () => IssueResponseDto, isArray: true })
  issues: IssueResponseDto[];
}

export class ScanResponseDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'https://example.com' })
  url: string;

  @ApiPropertyOptional({
    example: 'main',
    description:
      'CSS selector used to scope the scan. Null means the entire page was scanned.',
  })
  rootElement?: string;

  @ApiProperty({ enum: ScanStatus, example: ScanStatus.COMPLETED })
  status: ScanStatus;

  @ApiProperty({ type: () => ViolationResponseDto, isArray: true })
  violations: ViolationResponseDto[];

  @ApiProperty({
    example: 3,
    description: 'Sum of issues across all violations',
  })
  totalIssueCount: number;

  @ApiProperty({
    example: '2025-06-14T10:30:00.000Z',
    type: 'string',
    format: 'date-time',
  })
  createdAt: Date;

  @ApiProperty({
    example: '2025-06-14T10:31:00.000Z',
    type: 'string',
    format: 'date-time',
  })
  updatedAt: Date;
}
