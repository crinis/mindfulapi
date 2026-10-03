import { plainToInstance, Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  Validate,
  ValidationArguments,
  validateSync,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { validateCronExpression } from 'cron';
import {
  DECIMAL_SETTINGS,
  DecimalSettingName,
  INTEGER_SETTINGS,
  IntegerSettingName,
  parseDecimalInt,
  parseDecimalNumber,
} from './numeric-settings';
import { parseTrustProxy } from './trust-proxy';

/** Parse error for a TRUST_PROXY value, or null when the app accepts it. */
function trustProxyError(value: unknown): string | null {
  try {
    parseTrustProxy(String(value));
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/** Accepts exactly the TRUST_PROXY values the app config parses. */
@ValidatorConstraint({ name: 'trustProxy' })
class TrustProxyConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return trustProxyError(value) === null;
  }

  defaultMessage(args: ValidationArguments): string {
    return trustProxyError(args.value) ?? 'TRUST_PROXY is invalid';
  }
}

/**
 * Accepts the cron expressions the scheduler accepts: @nestjs/schedule hands
 * CLEANUP_INTERVAL to the same `cron` package version.
 */
@ValidatorConstraint({ name: 'cronExpression' })
class CronExpressionConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && validateCronExpression(value).valid;
  }

  defaultMessage(args: ValidationArguments): string {
    const reason =
      typeof args.value === 'string'
        ? validateCronExpression(args.value).error?.message
        : undefined;
    return `${args.property} must be a valid cron expression such as "0 2 * * *"${reason ? ` (${reason})` : ''}`;
  }
}

/**
 * Converts the raw string with the same parser the config namespaces use.
 * Implicit conversion (`Number()`) would accept forms such as `0x50` or
 * `1.5e6` that the application then read differently.
 */
function parseRaw(parse: (raw: unknown) => number) {
  return Transform(({ obj, key }) => {
    const raw = (obj as Record<string, unknown>)[key];
    return raw === undefined ? undefined : parse(raw);
  });
}

/** An integer variable within its {@link INTEGER_SETTINGS} bounds. */
function IntegerSetting(): PropertyDecorator {
  return (target, propertyKey) => {
    const name = propertyKey as IntegerSettingName;
    const { min, max } = INTEGER_SETTINGS[name];
    for (const decorate of [
      IsOptional(),
      parseRaw(parseDecimalInt),
      IsInt({ message: `${name} must be a whole number in decimal digits` }),
      Min(min),
      Max(max),
    ]) {
      decorate(target, propertyKey);
    }
  };
}

/** A decimal variable within its {@link DECIMAL_SETTINGS} bounds. */
function DecimalSetting(): PropertyDecorator {
  return (target, propertyKey) => {
    const name = propertyKey as DecimalSettingName;
    const { min, max } = DECIMAL_SETTINGS[name];
    for (const decorate of [
      IsOptional(),
      parseRaw(parseDecimalNumber),
      IsNumber({}, { message: `${name} must be a decimal number such as 0.5` }),
      Min(min),
      Max(max),
    ]) {
      decorate(target, propertyKey);
    }
  };
}

/**
 * Declarative schema for every environment variable the application reads.
 *
 * Values arrive as strings. Numeric variables are parsed with the parsers the
 * config namespaces use and checked against the same bounds
 * (`numeric-settings.ts`), so a value that passes is used unchanged.
 * Boolean-ish flags are validated as the literal strings 'true'/'false' and
 * parsed in the config namespaces.
 */
export class EnvironmentVariables {
  @IsOptional()
  @IsString()
  NODE_ENV?: string;

  @IntegerSetting()
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

  @IntegerSetting()
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

  @IntegerSetting()
  CLEANUP_RETENTION_DAYS?: number;

  @IsOptional()
  @Validate(CronExpressionConstraint)
  CLEANUP_INTERVAL?: string;

  /** Concurrent pages within one scan job. */
  @IntegerSetting()
  CRAWL_CONCURRENCY?: number;

  /** Concurrent scan jobs processed by the BullMQ worker. */
  @IntegerSetting()
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
  @IntegerSetting()
  THROTTLE_TTL?: number;

  /** Allowed requests per window per client. */
  @IntegerSetting()
  THROTTLE_LIMIT?: number;

  /** Express `trust proxy` for client addresses behind a reverse proxy. */
  @IsOptional()
  @Validate(TrustProxyConstraint)
  TRUST_PROXY?: string;

  /** Master switch for the optional LLM-agent audit. */
  @IsOptional()
  @IsIn(['true', 'false'])
  AGENT_ENABLED?: string;

  /** LLM provider adapter. */
  @IsOptional()
  @IsIn(['openai', 'anthropic', 'openai-compatible'])
  AGENT_PROVIDER?: string;

  @IsOptional()
  @IsString()
  AGENT_MODEL?: string;

  /**
   * Provider API key. Its presence is checked when a scan requests the AI
   * audit; whether the provider accepts it shows only when requests run.
   */
  @IsOptional()
  @IsString()
  AGENT_API_KEY?: string;

  /** Base URL for the openai-compatible provider (OpenRouter/local). */
  @IsOptional()
  @IsString()
  AGENT_BASE_URL?: string;

  /** Comma-separated skills the server permits clients to request. */
  @IsOptional()
  @IsString()
  AGENT_SKILLS?: string;

  /** Comma-separated scan modes for which AI audits may be requested. */
  @IsOptional()
  @IsString()
  @Matches(
    /^\s*(?:(?:single_url|url_list|crawl)(?:\s*,\s*(?:single_url|url_list|crawl))*)?\s*$/,
    {
      message:
        'AGENT_ALLOWED_SCAN_MODES must be a comma-separated list containing only single_url, url_list, or crawl',
    },
  )
  AGENT_ALLOWED_SCAN_MODES?: string;

  /** Concurrent per-unit requests during evaluation. */
  @IntegerSetting()
  AGENT_CONCURRENCY?: number;

  @IntegerSetting()
  AGENT_MAX_UNITS_PER_PAGE?: number;

  @IntegerSetting()
  AGENT_MAX_UNITS_PER_SCAN?: number;

  /** Output-token cap per individual request. */
  @IntegerSetting()
  AGENT_MAX_TOKENS_PER_REQUEST?: number;

  @IntegerSetting()
  AGENT_REQUEST_TIMEOUT_MS?: number;

  @IntegerSetting()
  AGENT_MAX_IMAGE_BYTES?: number;

  /** Sampling temperature (0–2). */
  @DecimalSetting()
  AGENT_TEMPERATURE?: number;

  /** Reasoning effort for a reasoning `AGENT_MODEL`. */
  @IsOptional()
  @IsIn(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])
  AGENT_REASONING_EFFORT?: string;

  // Per-skill overrides (AGENT_SKILL_<ID>_{PROVIDER,MODEL,API_KEY,BASE_URL,
  // REASONING_EFFORT}) are read dynamically per registered skill in
  // configuration.ts, so they are not declared here. A scan that requests a
  // skill is rejected with 400 when the skill's resolved provider, model, key
  // or base URL is missing or unsupported; anything else surfaces when its
  // requests run.
}

/**
 * Validation hook for `ConfigModule.forRoot` — throws a readable error at
 * bootstrap when any environment variable has an invalid value.
 *
 * An empty value (`VAR=` in `.env`, or a `${VAR:-}` default in compose) means
 * "unset" for every variable: the config namespaces read each one as
 * `process.env.VAR || default` (an empty `REDIS_PASSWORD` is no password, an
 * empty `AGENT_SKILLS` allows every skill), so validation must not reject what
 * the application treats as unset.
 */
export function validate(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const setValues = Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== ''),
  );
  const validated = plainToInstance(EnvironmentVariables, setValues, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, {
    skipMissingProperties: true,
    stopAtFirstError: true,
  });

  if (errors.length > 0) {
    const details = errors
      .map((error) => Object.values(error.constraints ?? {}).join(', '))
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return validated;
}
