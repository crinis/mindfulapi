import { ApiProperty } from '@nestjs/swagger';

/**
 * Metadata describing an axe-core rule associated with reported issues.
 */
export class RuleResponseDto {
  /** Stable axe-core rule identifier. */
  @ApiProperty({
    example: 'color-contrast',
    description: 'Axe rule identifier.',
  })
  id: string;

  /** Human-readable rule description used in result summaries. */
  @ApiProperty({ example: 'Elements must have sufficient color contrast' })
  description: string;

  /** Link to external remediation guidance for the rule. */
  @ApiProperty({
    example:
      'https://dequeuniversity.com/rules/axe/4.11/color-contrast?application=axeAPI',
    description: 'Link to remediation guidance on Deque University.',
    format: 'uri',
    nullable: true,
  })
  helpUrl: string | null | undefined;

  /** Tags associated with the rule (e.g., WCAG mappings). Present on /rules responses, absent on violations. */
  @ApiProperty({
    example: ['wcag2aa', 'wcag143', 'cat.color'],
    description: 'WCAG and category tags for this rule.',
    isArray: true,
    uniqueItems: true,
    required: false,
  })
  tags?: string[];
}
