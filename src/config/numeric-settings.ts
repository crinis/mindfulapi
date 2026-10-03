/**
 * Bounds and defaults of the numeric environment variables, shared by the env
 * validation schema and the config namespaces so that every value validation
 * accepts is used unchanged: nothing is clamped or parsed differently after
 * validation passed.
 */
interface NumericSetting {
  min: number;
  max: number;
  default: number;
}

/** Integer variables. Values must be plain decimal digits. */
export const INTEGER_SETTINGS = {
  PORT: { min: 1, max: 65_535, default: 3000 },
  REDIS_PORT: { min: 1, max: 65_535, default: 6379 },
  THROTTLE_TTL: { min: 1, max: 86_400, default: 60 },
  THROTTLE_LIMIT: { min: 1, max: 1_000_000, default: 100 },
  CLEANUP_RETENTION_DAYS: { min: 0, max: 36_500, default: 30 },
  CRAWL_CONCURRENCY: { min: 1, max: 16, default: 4 },
  SCAN_CONCURRENCY: { min: 1, max: 8, default: 1 },
  SCAN_PAGE_TIMEOUT_MS: { min: 30_000, max: 1_800_000, default: 120_000 },
  AGENT_CONCURRENCY: { min: 1, max: 16, default: 4 },
  AGENT_MAX_UNITS_PER_PAGE: { min: 1, max: 500, default: 30 },
  AGENT_MAX_UNITS_PER_SCAN: { min: 1, max: 10_000, default: 200 },
  AGENT_MAX_TOKENS_PER_REQUEST: { min: 1, max: 100_000, default: 2000 },
  AGENT_REQUEST_TIMEOUT_MS: { min: 1000, max: 600_000, default: 60_000 },
  AGENT_MAX_IMAGE_BYTES: { min: 1000, max: 20_000_000, default: 1_500_000 },
} as const satisfies Record<string, NumericSetting>;

/** Decimal variables, such as `0.7`. */
export const DECIMAL_SETTINGS = {
  AGENT_TEMPERATURE: { min: 0, max: 2, default: 0 },
} as const satisfies Record<string, NumericSetting>;

export type IntegerSettingName = keyof typeof INTEGER_SETTINGS;
export type DecimalSettingName = keyof typeof DECIMAL_SETTINGS;

/**
 * Parses plain decimal digits (surrounding whitespace allowed). Anything else
 * — `0x50`, `1.5e6`, `80.5`, `6379abc` — is NaN, where `parseInt` would have
 * read a different number than the validator.
 */
export function parseDecimalInt(raw: unknown): number {
  return typeof raw === 'string' && /^\s*\d+\s*$/.test(raw)
    ? Number(raw)
    : Number.NaN;
}

/** Parses a plain decimal number such as `0`, `0.7` or `.5`; NaN otherwise. */
export function parseDecimalNumber(raw: unknown): number {
  return typeof raw === 'string' && /^\s*(?:\d+(?:\.\d+)?|\.\d+)\s*$/.test(raw)
    ? Number(raw)
    : Number.NaN;
}

/** Default when the value does not parse, else the value within the bounds. */
function read(
  parsed: number,
  { min, max, default: fallback }: NumericSetting,
): number {
  if (Number.isNaN(parsed)) return fallback;
  // Env validation rejects out-of-range values at startup; the clamp only
  // matters for code that reads the config without validating it (tests).
  return Math.min(Math.max(parsed, min), max);
}

/** Reads an integer variable from `process.env`; unset or empty is the default. */
export function readIntSetting(name: IntegerSettingName): number {
  return read(parseDecimalInt(process.env[name]), INTEGER_SETTINGS[name]);
}

/** Reads a decimal variable from `process.env`; unset or empty is the default. */
export function readDecimalSetting(name: DecimalSettingName): number {
  return read(parseDecimalNumber(process.env[name]), DECIMAL_SETTINGS[name]);
}
