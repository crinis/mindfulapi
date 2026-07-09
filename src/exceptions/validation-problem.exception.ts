import { BadRequestException } from '@nestjs/common';
import { ValidationError } from 'class-validator';

/** A flattened field-level validation error. */
export interface FieldError {
  /** JSON Pointer to the offending field. */
  pointer: string;
  /** Human-readable constraint message. */
  message: string;
}

/**
 * Raised by the global ValidationPipe's exception factory. Carries structured
 * field errors so the problem-details filter can emit them as the RFC 9457
 * `errors` extension member.
 */
export class ValidationProblemException extends BadRequestException {
  constructor(public readonly fieldErrors: FieldError[]) {
    super('Validation failed');
  }
}

/**
 * Flattens nested class-validator errors into JSON-Pointer/message pairs.
 *
 * @param errors Errors produced by the ValidationPipe.
 * @param parentPath Accumulated pointer prefix (used in recursion).
 */
export function flattenValidationErrors(
  errors: ValidationError[],
  parentPath = '',
): FieldError[] {
  const result: FieldError[] = [];

  for (const error of errors) {
    const pointer = `${parentPath}/${error.property}`;
    if (error.constraints) {
      for (const message of Object.values(error.constraints)) {
        result.push({ pointer, message });
      }
    }
    if (error.children?.length) {
      result.push(...flattenValidationErrors(error.children, pointer));
    }
  }

  return result;
}
