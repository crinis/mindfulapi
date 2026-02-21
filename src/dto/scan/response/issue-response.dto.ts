import { ApiProperty } from '@nestjs/swagger';

/**
 * Single occurrence of a violation on a specific page/DOM location.
 */
export class IssueResponseDto {
  /** Unique persisted issue identifier. */
  @ApiProperty({ example: 1, minimum: 1 })
  id: number;

  /** Canonical URL of the page where this occurrence was detected. */
  @ApiProperty({
    example: 'https://example.com/about',
    description: 'Page URL where this issue occurrence was found.',
    nullable: true,
    format: 'uri',
  })
  pageUrl: string | null;

  /** CSS selector pointing to the problematic element. */
  @ApiProperty({
    example: '.btn-primary',
    description: 'CSS selector identifying the element with the issue.',
    nullable: true,
  })
  selector: string | null;

  /** HTML snippet for quick issue context in clients. */
  @ApiProperty({
    example: '<button class="btn-primary">Submit</button>',
    description: 'HTML snippet of the problematic element.',
    nullable: true,
  })
  context: string | null;
}
