import { ApiProperty } from '@nestjs/swagger';

/**
 * Standard error response shape returned by NestJS for all HTTP exceptions.
 * Matches the format produced by the built-in HttpException filter.
 */
export class ErrorResponseDto {
  @ApiProperty({ example: 400, description: 'HTTP status code' })
  statusCode: number;

  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    example: ['url must be a URL address'],
    description: 'Human-readable error message or array of validation messages',
  })
  message: string | string[];

  @ApiProperty({
    example: 'Bad Request',
    description: 'Short error classification',
  })
  error: string;
}
