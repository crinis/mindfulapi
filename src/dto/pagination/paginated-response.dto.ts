import { applyDecorators, Type as NestType } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiProperty,
  getSchemaPath,
} from '@nestjs/swagger';

/**
 * Generic pagination envelope. `items` is documented per-endpoint via the
 * {@link ApiPaginatedResponse} decorator, since @nestjs/swagger cannot express
 * generic type parameters directly.
 */
export class PaginatedResponseDto<T> {
  /** The page of results. */
  items: T[];

  /** Total number of items across all pages. */
  @ApiProperty({
    type: 'integer',
    example: 42,
    minimum: 0,
    description: 'Total number of items matching the query.',
  })
  total: number;

  /** The `limit` that was applied to this page. */
  @ApiProperty({
    type: 'integer',
    example: 20,
    minimum: 1,
    description: 'Maximum number of items returned per page.',
  })
  limit: number;

  /** The `offset` that was applied to this page. */
  @ApiProperty({
    type: 'integer',
    example: 0,
    minimum: 0,
    description: 'Number of items skipped before this page.',
  })
  offset: number;
}

/**
 * Documents a paginated response whose `items` are instances of `model`.
 *
 * @param model The item DTO class.
 */
export function ApiPaginatedResponse<TModel extends NestType>(
  model: TModel,
): MethodDecorator {
  return applyDecorators(
    ApiExtraModels(PaginatedResponseDto, model),
    ApiOkResponse({
      description: 'A page of results',
      schema: {
        allOf: [
          { $ref: getSchemaPath(PaginatedResponseDto) },
          {
            properties: {
              items: {
                type: 'array',
                items: { $ref: getSchemaPath(model) },
              },
            },
          },
        ],
      },
    }),
  );
}
