import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  validateSync,
} from 'class-validator';

/**
 * Declarative schema for every environment variable the application reads.
 *
 * Values arrive as strings; numeric properties are converted via implicit
 * class-transformer conversion so malformed numbers fail validation instead
 * of silently falling back. Boolean-ish flags are validated as the literal
 * strings 'true'/'false' and parsed in the config namespaces.
 */
export class EnvironmentVariables {
  @IsOptional()
  @IsString()
  NODE_ENV?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT?: number;

  @IsOptional()
  @IsString()
  AUTH_TOKEN?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  AUTH_DISABLED?: string;

  @IsOptional()
  @IsString()
  DATABASE_PATH?: string;

  @IsOptional()
  @IsString()
  REDIS_HOST?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  REDIS_PORT?: number;

  @IsOptional()
  @IsString()
  REDIS_PASSWORD?: string;

  @IsOptional()
  @IsString()
  PLAYWRIGHT_WS_URL?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  IGNORE_HTTPS_ERRORS?: string;

  /** Parsed and length-checked lazily by BasicAuthCryptoService. */
  @IsOptional()
  @IsString()
  ENCRYPTION_KEY?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  CLEANUP_ENABLED?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  CLEANUP_RETENTION_DAYS?: number;

  @IsOptional()
  @IsString()
  CLEANUP_INTERVAL?: string;

  /** Concurrent pages within one scan job. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(16)
  CRAWL_CONCURRENCY?: number;

  /** Concurrent scan jobs processed by the BullMQ worker. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8)
  SCAN_CONCURRENCY?: number;

  @IsOptional()
  @IsIn(['true', 'false'])
  SCAN_ALLOW_PRIVATE_TARGETS?: string;

  /** Comma-separated hostnames exempt from the private-target block. */
  @IsOptional()
  @IsString()
  SCAN_TARGET_ALLOW_HOSTS?: string;

  /** Comma-separated allowed CORS origins; unset disables CORS. */
  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;

  /** Rate-limit window in seconds. */
  @IsOptional()
  @IsInt()
  @Min(1)
  THROTTLE_TTL?: number;

  /** Allowed requests per window per client. */
  @IsOptional()
  @IsInt()
  @Min(1)
  THROTTLE_LIMIT?: number;
}

/**
 * Validation hook for `ConfigModule.forRoot` — throws a readable error at
 * bootstrap when any environment variable has an invalid value.
 */
export function validate(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: true });

  if (errors.length > 0) {
    const details = errors
      .map((error) => Object.values(error.constraints ?? {}).join(', '))
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return validated;
}
