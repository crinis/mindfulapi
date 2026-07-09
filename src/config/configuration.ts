import { registerAs } from '@nestjs/config';
import { CronExpression } from '@nestjs/schedule';
import { AgentSkill } from '../enums/agent-skill.enum';

/** Provider/model/credentials for a single agent skill (or the global default). */
export interface AgentModelConfig {
  provider: string | null;
  model: string | null;
  apiKey: string | null;
  baseUrl: string | null;
}

/**
 * Reads an optional per-skill model override from
 * `AGENT_SKILL_<ID>_{PROVIDER,MODEL,API_KEY,BASE_URL}` (e.g.
 * `AGENT_SKILL_IMAGE_ALT_TEXT_MODEL`). Any unset field falls back to the global
 * `AGENT_*` default at resolution time.
 */
function readSkillModelOverride(skill: string): AgentModelConfig | null {
  const prefix = `AGENT_SKILL_${skill.toUpperCase()}`;
  const override: AgentModelConfig = {
    provider: process.env[`${prefix}_PROVIDER`] || null,
    model: process.env[`${prefix}_MODEL`] || null,
    apiKey: process.env[`${prefix}_API_KEY`] || null,
    baseUrl: process.env[`${prefix}_BASE_URL`] || null,
  };
  const hasAny = Object.values(override).some((value) => value !== null);
  return hasAny ? override : null;
}

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

/** Clamps a parsed float into [min, max], falling back when not a number. */
function clampFloat(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = parseFloat(raw ?? '');
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
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

/**
 * Optional LLM-agent audit settings.
 *
 * Powers the agentic accessibility skills that run in addition to axe-core.
 * The API key is read here but only validated lazily by the model harness
 * (mirrors the ENCRYPTION_KEY handling) so the app boots without a key when
 * the feature is disabled.
 */
export const agentConfig = registerAs('agent', () => ({
  /** Master switch for the AI audit capability. */
  enabled: process.env.AGENT_ENABLED === 'true',
  /** Default provider adapter: openai | anthropic | openai-compatible. */
  provider: process.env.AGENT_PROVIDER || null,
  /** Default model identifier passed to the provider (e.g. `gpt-4o-mini`). */
  model: process.env.AGENT_MODEL || null,
  /** Default provider API key; validated lazily by the harness, never logged. */
  apiKey: process.env.AGENT_API_KEY || null,
  /**
   * Default base URL for the `openai-compatible` provider — point at OpenRouter
   * or a local server (Ollama/vLLM/LM Studio) for broad model coverage.
   */
  baseUrl: process.env.AGENT_BASE_URL || null,
  /**
   * Per-skill model overrides, keyed by skill id. Each field falls back to the
   * global `AGENT_*` default when unset, so a skill can point at a different
   * provider/model/gateway without duplicating shared settings.
   */
  skillModels: Object.fromEntries(
    Object.values(AgentSkill)
      .map((skill) => [skill, readSkillModelOverride(skill)] as const)
      .filter(([, override]) => override !== null),
  ) as Record<string, AgentModelConfig>,
  /** Skills the server permits clients to request; defaults to image alt text. */
  allowedSkills: ((): string[] => {
    const configured = splitList(process.env.AGENT_SKILLS);
    return configured.length > 0 ? configured : ['image_alt_text'];
  })(),
  /** Concurrent per-unit requests (subagent fan-out) during evaluation. */
  concurrency: clampInt(process.env.AGENT_CONCURRENCY, 4, 1, 16),
  /** Max work units collected per page across all skills. */
  maxUnitsPerPage: clampInt(process.env.AGENT_MAX_UNITS_PER_PAGE, 30, 1, 500),
  /** Max work units evaluated per scan across all skills. */
  maxUnitsPerScan: clampInt(
    process.env.AGENT_MAX_UNITS_PER_SCAN,
    200,
    1,
    10000,
  ),
  /** Output-token cap per individual request. */
  maxTokensPerRequest: clampInt(
    process.env.AGENT_MAX_TOKENS_PER_REQUEST,
    1000,
    1,
    100000,
  ),
  /** Total token budget per scan; 0 disables the budget check. */
  tokenBudgetPerScan: clampInt(
    process.env.AGENT_TOKEN_BUDGET_PER_SCAN,
    2_000_000,
    0,
    1_000_000_000,
  ),
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs: clampInt(
    process.env.AGENT_REQUEST_TIMEOUT_MS,
    60_000,
    1000,
    600_000,
  ),
  /** Skip element screenshots larger than this many bytes. */
  maxImageBytes: clampInt(
    process.env.AGENT_MAX_IMAGE_BYTES,
    1_500_000,
    1000,
    20_000_000,
  ),
  /** Sampling temperature; 0 favours deterministic, low-hallucination output. */
  temperature: clampFloat(process.env.AGENT_TEMPERATURE, 0, 0, 2),
}));

/** Scheduled data-retention cleanup settings. */
export const cleanupConfig = registerAs('cleanup', () => ({
  enabled: process.env.CLEANUP_ENABLED !== 'false',
  retentionDays: clampInt(process.env.CLEANUP_RETENTION_DAYS, 30, 0, 36500),
  interval: process.env.CLEANUP_INTERVAL || CronExpression.EVERY_DAY_AT_2AM,
}));
