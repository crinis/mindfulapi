import { Injectable, PipeTransform } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ScanMode } from '../enums/scan-mode.enum';
import { CREATE_SCAN_VARIANTS, CreateScanRequest } from '../dto/scan/request';
import {
  flattenValidationErrors,
  ValidationProblemException,
} from '../exceptions/validation-problem.exception';

/**
 * Validates a create-scan request body against the variant class selected by
 * its `mode` discriminator.
 *
 * NestJS's global ValidationPipe cannot validate a TypeScript union body (the
 * metatype erases to `Object`), so this pipe transforms and validates the body
 * against the concrete variant, with `whitelist`/`forbidNonWhitelisted` so that
 * fields belonging to another mode are rejected — replacing the previous
 * hand-written cross-field checks.
 */
@Injectable()
export class DiscriminatedBodyPipe implements PipeTransform<
  unknown,
  Promise<CreateScanRequest>
> {
  async transform(value: unknown): Promise<CreateScanRequest> {
    const mode = (value as { mode?: unknown })?.mode;
    const variant = CREATE_SCAN_VARIANTS[mode as ScanMode];

    if (!variant) {
      throw new ValidationProblemException([
        {
          pointer: '/mode',
          message: `mode must be one of: ${Object.values(ScanMode).join(', ')}`,
        },
      ]);
    }

    const instance = plainToInstance(
      variant as new () => CreateScanRequest,
      value,
    );
    const errors = await validate(instance, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    if (errors.length > 0) {
      throw new ValidationProblemException(flattenValidationErrors(errors));
    }

    return instance;
  }
}
