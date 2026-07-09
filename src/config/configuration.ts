import { registerAs } from '@nestjs/config';
import { CronExpression } from '@nestjs/schedule';

/** Clamps a parsed integer into [min, max], falling back when not a number. */
function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/** Splits a comma-separated env value into trimmed non-empty entries. */
function splitList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** HTTP server and general application settings. */
export const appConfig = registerAs('app', () => ({
  port: clampInt(process.env.PORT, 3000, 1, 65535),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  /** Allowed CORS origins; empty list means CORS stays disabled. */
  corsOrigins: splitList(process.env.CORS_ORIGINS),
}));

/** Authentication and rate-limit settings. */
export const securityConfig = registerAs('security', () => ({
  authToken: process.env.AUTH_TOKEN || null,
  authDisabled: process.env.AUTH_DISABLED === 'true',
  throttleTtlSeconds: clampInt(process.env.THROTTLE_TTL, 60, 1, 86400),
  throttleLimit: clampInt(process.env.THROTTLE_LIMIT, 100, 1, 1_000_000),
}));

/** Redis connection used by the BullMQ queue. */
export const redisConfig = registerAs('redis', () => ({
  host: process.env.REDIS_HOST || 'localhost',
  port: clampInt(process.env.REDIS_PORT, 6379, 1, 65535),
  password: process.env.REDIS_PASSWORD || undefined,
}));

/** SQLite database location and logging. */
export const databaseConfig = registerAs('database', () => ({
  path: process.env.DATABASE_PATH || './data/database.sqlite',
  logging: (process.env.NODE_ENV ?? 'development') !== 'production',
}));

/** Scan execution settings shared by the processor and browser services. */
export const scanConfig = registerAs('scan', () => ({
  /** Concurrent pages within one scan job (crawl and url_list modes). */
  crawlConcurrency: clampInt(process.env.CRAWL_CONCURRENCY, 4, 1, 16),
  /** Concurrent scan jobs processed by the BullMQ worker. */
  scanConcurrency: clampInt(process.env.SCAN_CONCURRENCY, 1, 1, 8),
  /** Allows scanning private/internal network targets when true. */
  allowPrivateTargets: process.env.SCAN_ALLOW_PRIVATE_TARGETS === 'true',
  /** Hostnames exempt from the private-target block. */
  targetAllowHosts: splitList(process.env.SCAN_TARGET_ALLOW_HOSTS),
  playwrightWsUrl: process.env.PLAYWRIGHT_WS_URL || null,
  ignoreHttpsErrors: process.env.IGNORE_HTTPS_ERRORS === 'true',
}));

/** Scheduled data-retention cleanup settings. */
export const cleanupConfig = registerAs('cleanup', () => ({
  enabled: process.env.CLEANUP_ENABLED !== 'false',
  retentionDays: clampInt(process.env.CLEANUP_RETENTION_DAYS, 30, 0, 36500),
  interval: process.env.CLEANUP_INTERVAL || CronExpression.EVERY_DAY_AT_2AM,
}));
