import { registerAs } from '@nestjs/config';
import { CronExpression } from '@nestjs/schedule';
import { AgentSkill } from '../enums/agent-skill.enum';

/** Provider/model/credentials for a single agent skill (or the global default). */
export interface AgentModelConfig {
  provider: string | null;
  model: string | null;
  apiKey: string | null;
  baseUrl: string | null;
  /**
   * OpenAI reasoning effort (`none` | `low` | `medium` | `high`; the original
   * `gpt-5-nano`/`gpt-5-mini` also accept `minimal`, but `gpt-5.4+` reject it).
   * Set for reasoning models (GPT-5 family); when set, the harness passes it and
   * omits `temperature` (reasoning models reject a non-default temperature).
   */
  reasoningEffort: string | null;
}

/** A model choice in a provider profile: the id plus optional reasoning effort. */
export interface ProfileModel {
  model: string;
  /** OpenAI reasoning effort for this model; omit for sampling (non-reasoning) models. */
  reasoningEffort?: string;
}

/** A gateway/provider's tuned default model set for the agent skills. */
export interface ProviderModelProfile {
  /** Model used for any skill without a `perSkill` entry. */
  default: ProfileModel;
  /** Per-skill tuned models (minimal sufficient model, from live A/B testing). */
  perSkill: Partial<Record<AgentSkill, ProfileModel>>;
}

/**
 * Built-in, tuned default model sets keyed by provider. When a provider is
 * selected but no explicit model is configured (`AGENT_MODEL` unset and no
 * `AGENT_SKILL_<ID>_MODEL` override), each skill uses the model tuned for it
 * here — the "optimized default set" for that gateway. Explicit env always
 * wins over a profile (precedence lives in the factory's `resolveModelConfig`).
 *
 * The gpt-4.x family is legacy (de-featured on OpenAI's pricing page), so the
 * profile targets the current GPT-5 line. These are reasoning models: they run
 * with an explicit reasoning effort and the harness omits `temperature` for
 * them. Values are the minimal model + effort that held up in per-skill A/B
 * testing (accuracy versus token cost, chosen for accuracy WITHOUT
 * over-flagging — a false "issue" on a clean page is as harmful as a miss):
 * - `link_purpose`, `page_title` — simple text classification; the cheapest
 *   `gpt-5.4-nano` at `none` effort matched the larger models (8/8).
 * - `form_labels` — GPT-5's reasoning-native `gpt-5.4-nano` at `none` now
 *   catches the descriptiveness / instruction gaps the legacy nano missed
 *   entirely, with no false positive on placeholder-labelled fields. (Premium
 *   option for zero-defect: `gpt-5.4-mini` at `low`.)
 * - `image_alt_text` — needs a vision-capable model, so `gpt-5.4-mini`; at
 *   `none` effort it reads the screenshot and judges accurately.
 * - `heading_structure` — multi-verdict structural reasoning; `gpt-5.4-mini`
 *   at `low` effort was the only combo with zero false positives AND full
 *   recall (9/9). Lower tiers/effort over-flag clean pages.
 *
 * Only OpenAI is provided for now. Providers without a profile (anthropic,
 * openai-compatible) fall back to the global `AGENT_MODEL` until one is added.
 */
export const PROVIDER_MODEL_PROFILES: Record<string, ProviderModelProfile> = {
  openai: {
    default: { model: 'gpt-5.4-mini', reasoningEffort: 'none' },
    perSkill: {
      [AgentSkill.IMAGE_ALT_TEXT]: {
        model: 'gpt-5.4-mini',
        reasoningEffort: 'none',
      },
      [AgentSkill.HEADING_STRUCTURE]: {
        model: 'gpt-5.4-mini',
        reasoningEffort: 'low',
      },
      [AgentSkill.LINK_PURPOSE]: {
        model: 'gpt-5.4-nano',
        reasoningEffort: 'none',
      },
      [AgentSkill.FORM_LABELS]: {
        model: 'gpt-5.4-nano',
        reasoningEffort: 'none',
      },
      [AgentSkill.PAGE_TITLE]: {
        model: 'gpt-5.4-nano',
        reasoningEffort: 'none',
      },
    },
  },
};

/**
 * Resolves the tuned profile entry (model + reasoning effort) for a provider +
 * skill, or the provider's profile default, or `null` when the provider has no
 * profile. Kept here (next to the profile table) so the resolution order lives
 * in one place.
 */
export function resolveProfileEntry(
  provider: string,
  skill?: string,
): ProfileModel | null {
  const profile = PROVIDER_MODEL_PROFILES[provider];
  if (!profile) return null;
  if (skill && skill in profile.perSkill) {
    return profile.perSkill[skill as AgentSkill] ?? profile.default;
  }
  return profile.default;
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
    reasoningEffort: process.env[`${prefix}_REASONING_EFFORT`] || null,
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
  /** Default model identifier passed to the provider (e.g. `gpt-5.4-mini`). */
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
  /** Skills the server permits clients to request; defaults to all built-ins. */
  allowedSkills: ((): string[] => {
    const configured = splitList(process.env.AGENT_SKILLS);
    return configured.length > 0
      ? configured
      : [
          'image_alt_text',
          'heading_structure',
          'link_purpose',
          'form_labels',
          'page_title',
        ];
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
  /**
   * Output-token cap per individual request. Covers reasoning tokens too, so it
   * is set with headroom for reasoning models (the heaviest skill,
   * `heading_structure` at `low` effort, peaked ~470 but reasoning counts vary).
   */
  maxTokensPerRequest: clampInt(
    process.env.AGENT_MAX_TOKENS_PER_REQUEST,
    2000,
    1,
    100000,
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
  /**
   * Global reasoning effort applied to reasoning models when no profile/per-skill
   * value is set. Unset for the default (sampling) path; provide it only when
   * pointing `AGENT_MODEL` at a reasoning model.
   */
  reasoningEffort: process.env.AGENT_REASONING_EFFORT || null,
}));

/** Scheduled data-retention cleanup settings. */
export const cleanupConfig = registerAs('cleanup', () => ({
  enabled: process.env.CLEANUP_ENABLED !== 'false',
  retentionDays: clampInt(process.env.CLEANUP_RETENTION_DAYS, 30, 0, 36500),
  interval: process.env.CLEANUP_INTERVAL || CronExpression.EVERY_DAY_AT_2AM,
}));
