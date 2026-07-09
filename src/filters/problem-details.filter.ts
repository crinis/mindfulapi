import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Request } from 'express';
import { ProblemDetailsDto } from '../dto/problem-details.dto';
import { ValidationProblemException } from '../exceptions/validation-problem.exception';

/** Documentation anchor for the validation problem type. */
const VALIDATION_PROBLEM_TYPE =
  'https://github.com/crinis/mindfulapi/blob/main/docs/problems.md#validation-error';

/**
 * Global exception filter that renders every error as an RFC 9457
 * `application/problem+json` document with a consistent shape.
 *
 * Unhandled (non-HTTP) errors become a generic 500 without leaking internals.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<unknown>();

    const problem = this.toProblem(exception, request.url);

    if (problem.status >= 500) {
      this.logger.error(
        `Unhandled error on ${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    httpAdapter.setHeader(response, 'Content-Type', 'application/problem+json');
    httpAdapter.reply(response, problem, problem.status);
  }

  /**
   * Maps an arbitrary thrown value onto a ProblemDetails document.
   */
  private toProblem(exception: unknown, instance: string): ProblemDetailsDto {
    if (exception instanceof ValidationProblemException) {
      return {
        type: VALIDATION_PROBLEM_TYPE,
        title: 'Validation Failed',
        status: HttpStatus.BAD_REQUEST,
        detail: 'One or more fields failed validation.',
        instance,
        errors: exception.fieldErrors.map((error) => ({
          pointer: error.pointer,
          message: error.message,
        })),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        type: 'about:blank',
        title: this.titleFor(status),
        status,
        detail: this.detailFrom(exception),
        instance,
      };
    }

    return {
      type: 'about:blank',
      title: 'Internal Server Error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: 'An unexpected error occurred.',
      instance,
    };
  }

  /**
   * Extracts a human-readable detail string from a Nest HttpException,
   * collapsing the framework's `{ message, error, statusCode }` envelope.
   */
  private detailFrom(exception: HttpException): string {
    const responseBody = exception.getResponse();
    if (typeof responseBody === 'string') {
      return responseBody;
    }
    if (responseBody && typeof responseBody === 'object') {
      const message = (responseBody as { message?: unknown }).message;
      if (typeof message === 'string') {
        return message;
      }
      if (Array.isArray(message)) {
        return message.join('; ');
      }
    }
    return exception.message;
  }

  /**
   * Returns the standard reason phrase for a status code.
   */
  private titleFor(status: number): string {
    const key = HttpStatus[status] as string | undefined;
    if (!key) {
      return 'Error';
    }
    return key
      .toLowerCase()
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
}
