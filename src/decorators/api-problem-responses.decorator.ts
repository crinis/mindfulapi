import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { ProblemDetailsDto } from '../dto/problem-details.dto';

/** Human-readable descriptions keyed by HTTP status. */
const STATUS_DESCRIPTIONS: Record<number, string> = {
  400: 'Validation failed or malformed request',
  401: 'Missing or invalid Bearer token',
  403: 'Insufficient permissions',
  404: 'Resource not found',
  409: 'Request conflicts with the current resource state',
  429: 'Rate limit exceeded',
  500: 'Unexpected server error',
  503: 'Service temporarily unavailable',
};

/**
 * Documents a set of error responses as `application/problem+json`, backed by
 * {@link ProblemDetailsDto}. Factored out so controllers don't repeat the same
 * five `@ApiResponse` blocks.
 *
 * @param statuses HTTP status codes to document (defaults to 401/500).
 */
export function ApiProblemResponses(
  ...statuses: number[]
): MethodDecorator & ClassDecorator {
  const codes = statuses.length ? statuses : [401, 500];
  return applyDecorators(
    ...codes.map((status) =>
      ApiResponse({
        status,
        description: STATUS_DESCRIPTIONS[status] ?? 'Error',
        type: ProblemDetailsDto,
        content: {
          'application/problem+json': {
            schema: { $ref: '#/components/schemas/ProblemDetailsDto' },
          },
        },
      }),
    ),
  );
}
