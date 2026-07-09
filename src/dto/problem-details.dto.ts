import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * A single field-level validation error, following the RFC 9457 pattern of
 * carrying structured detail in an extension member.
 */
export class ValidationErrorDetail {
  /** JSON Pointer to the offending field (e.g. `/urls`). */
  @ApiProperty({
    example: '/urls',
    description: 'JSON Pointer to the field that failed validation.',
  })
  pointer: string;

  /** Human-readable description of the constraint violation. */
  @ApiProperty({
    example: 'urls must contain at least 2 elements',
    description: 'Human-readable validation message.',
  })
  message: string;
}

/**
 * Error response body following RFC 9457 (Problem Details for HTTP APIs).
 *
 * Served with `Content-Type: application/problem+json`.
 */
export class ProblemDetailsDto {
  /** URI reference identifying the problem type. */
  @ApiProperty({
    example: 'about:blank',
    description:
      'A URI reference identifying the problem type. `about:blank` is used for problems with no dedicated documentation.',
  })
  type: string;

  /** Short, human-readable summary of the problem type. */
  @ApiProperty({
    example: 'Bad Request',
    description: 'Short, human-readable summary of the problem type.',
  })
  title: string;

  /** HTTP status code. */
  @ApiProperty({
    type: 'integer',
    example: 400,
    minimum: 400,
    maximum: 599,
    description: 'HTTP status code for this occurrence.',
  })
  status: number;

  /** Human-readable explanation specific to this occurrence. */
  @ApiPropertyOptional({
    example: 'Scan with ID 42 not found',
    description: 'Human-readable explanation specific to this occurrence.',
  })
  detail?: string;

  /** URI reference identifying the specific occurrence (the request path). */
  @ApiPropertyOptional({
    example: '/v1/scans/42',
    description: 'URI reference identifying this specific occurrence.',
  })
  instance?: string;

  /** Extension member: field-level errors for validation failures. */
  @ApiPropertyOptional({
    type: [ValidationErrorDetail],
    description: 'Field-level validation errors (validation problems only).',
  })
  errors?: ValidationErrorDetail[];
}
