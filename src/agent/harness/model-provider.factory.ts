import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import type { LanguageModel } from 'ai';
import {
  agentConfig,
  AgentModelConfig,
  resolveProfileEntry,
} from '../../config/configuration';

/** A fully-resolved model configuration (skill override merged over defaults). */
export interface ResolvedModelConfig {
  provider: string;
  model: string;
  apiKey: string | null;
  baseUrl: string | null;
  /** Reasoning effort for reasoning models; null selects the sampling path. */
  reasoningEffort: string | null;
}

/** Providers a model can be built for. */
const SUPPORTED_PROVIDERS = ['openai', 'anthropic', 'openai-compatible'];

/** Providers whose API rejects every request without a key. */
const KEY_REQUIRED_PROVIDERS = ['openai', 'anthropic'];

/**
 * An AI-audit model setting is missing or unusable, so no request can be made
 * for the skill. The message names the environment variables to set and never
 * contains a configured value that may be secret (API keys, base URLs).
 */
export class AgentConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The environment variables that configure one skill's model. */
interface ModelSettingNames {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

/**
 * Names the settings to fix: the global variable, plus the skill's own
 * override variable when the problem concerns a skill.
 */
function settingNames(skill?: string): ModelSettingNames {
  const either = (field: string): string =>
    skill
      ? `AGENT_${field} or AGENT_SKILL_${skill.toUpperCase()}_${field}`
      : `AGENT_${field}`;
  return {
    provider: either('PROVIDER'),
    model: either('MODEL'),
    apiKey: either('API_KEY'),
    baseUrl: either('BASE_URL'),
  };
}

// The AI SDK packages are ESM-only, so they are imported lazily inside
// getModel(). This keeps them out of the module-load graph (Jest/CommonJS)
// for the common case where the audit is disabled, and defers loading to the
// first actual use.

/**
 * Resolves the configured provider/model into a Vercel AI SDK language model.
 *
 * The AI SDK is the single client abstraction: native providers give
 * best-in-class structured output and vision, while the `openai-compatible`
 * adapter (plus a base URL) reaches OpenRouter, DeepSeek, and local
 * open-weight servers (Ollama/vLLM/LM Studio) through one code path.
 *
 * Configuration is validated when a scan requests an AI audit
 * ({@link resolveUsableModelConfig}) and again before a model is built, not at
 * boot, so the app starts without provider credentials whenever the AI audit
 * is disabled.
 */
@Injectable()
export class ModelProviderFactory {
  /**
   * Built models cached per resolved config: provider, model, base URL and
   * API key. A built model carries its key, so skills that share a model but
   * not a key must not share the instance.
   */
  private readonly cache = new Map<string, LanguageModel>();

  constructor(
    @Inject(agentConfig.KEY)
    private readonly config: ConfigType<typeof agentConfig>,
  ) {}

  /**
   * Resolves the effective model config for a skill. Model precedence, highest
   * first: the per-skill env override (`AGENT_SKILL_<ID>_MODEL`), the explicit
   * global `AGENT_MODEL`, then the provider's built-in tuned profile (the
   * optimized default set — e.g. OpenAI runs the text skills on nano). Passing
   * no skill returns the provider default.
   *
   * @throws AgentConfigurationError When the provider is unset or not
   * supported, or no model is configured.
   */
  resolveModelConfig(skill?: string): ResolvedModelConfig {
    const override: AgentModelConfig | undefined = skill
      ? this.config.skillModels[skill]
      : undefined;
    const names = settingNames(skill);
    const subject = skill ? `skill ${skill}` : 'the AI audit';

    const provider = override?.provider ?? this.config.provider;
    if (!provider) {
      throw new AgentConfigurationError(
        `No provider configured for ${subject}: set ${names.provider}.`,
      );
    }
    if (!SUPPORTED_PROVIDERS.includes(provider)) {
      throw new AgentConfigurationError(
        `Unsupported provider '${provider}' for ${subject}: set ` +
          `${names.provider} to ${SUPPORTED_PROVIDERS.join(', ')}.`,
      );
    }
    // The profile only supplies the model when neither the per-skill env nor the
    // global AGENT_MODEL does; its reasoning effort is used only in that case.
    const usesProfileModel = !override?.model && !this.config.model;
    const profile = resolveProfileEntry(provider, skill);
    const model =
      override?.model ?? this.config.model ?? profile?.model ?? null;
    if (!model) {
      throw new AgentConfigurationError(
        `No model configured for ${subject}: the ${provider} provider has no ` +
          `built-in model profile, so set ${names.model}.`,
      );
    }
    const reasoningEffort =
      override?.reasoningEffort ??
      (usesProfileModel ? profile?.reasoningEffort : undefined) ??
      this.config.reasoningEffort ??
      null;
    return {
      provider,
      model,
      apiKey: override?.apiKey ?? this.config.apiKey,
      baseUrl: override?.baseUrl ?? this.config.baseUrl,
      reasoningEffort,
    };
  }

  /**
   * Resolves a skill's model configuration and checks that a model can be
   * built from it: besides a supported provider and a model, an API key for
   * providers that require one and a base URL for `openai-compatible`. It cannot tell
   * whether the key is valid or the endpoint reachable; such failures surface
   * per request.
   *
   * @throws AgentConfigurationError Naming the settings to fix.
   */
  resolveUsableModelConfig(skill?: string): ResolvedModelConfig {
    const resolved = this.resolveModelConfig(skill);
    const names = settingNames(skill);
    const subject = skill ? `skill ${skill}` : 'the AI audit';
    const { provider } = resolved;

    if (KEY_REQUIRED_PROVIDERS.includes(provider) && !resolved.apiKey) {
      throw new AgentConfigurationError(
        `No API key configured for ${subject}: the ${provider} provider ` +
          `requires one, so set ${names.apiKey}.`,
      );
    }
    if (provider === 'openai-compatible' && !resolved.baseUrl) {
      throw new AgentConfigurationError(
        `No base URL configured for ${subject}: the openai-compatible ` +
          `provider requires one, so set ${names.baseUrl}.`,
      );
    }
    return resolved;
  }

  /**
   * Builds (and caches) the language model for a skill (or the global default).
   *
   * @throws AgentConfigurationError When required settings are missing.
   */
  async getModel(skill?: string): Promise<LanguageModel> {
    const { provider, model, apiKey, baseUrl } =
      this.resolveUsableModelConfig(skill);
    // The key enters the cache key only as a digest, so the map's keys never
    // hold the secret itself.
    const keyDigest = apiKey
      ? createHash('sha256').update(apiKey).digest('hex')
      : '';
    const cacheKey = `${provider}|${model}|${baseUrl ?? ''}|${keyDigest}`;
    const existing = this.cache.get(cacheKey);
    if (existing) {
      return existing;
    }

    let built: LanguageModel;
    switch (provider) {
      case 'openai': {
        const { createOpenAI } = await import('@ai-sdk/openai');
        const openai = createOpenAI({
          apiKey: apiKey ?? undefined,
          ...(baseUrl ? { baseURL: baseUrl } : {}),
        });
        built = openai(model);
        break;
      }
      case 'anthropic': {
        const { createAnthropic } = await import('@ai-sdk/anthropic');
        const anthropic = createAnthropic({
          apiKey: apiKey ?? undefined,
          ...(baseUrl ? { baseURL: baseUrl } : {}),
        });
        built = anthropic(model);
        break;
      }
      case 'openai-compatible': {
        const { createOpenAICompatible } =
          await import('@ai-sdk/openai-compatible');
        const compatible = createOpenAICompatible({
          name: 'agent',
          baseURL: baseUrl ?? '',
          ...(apiKey ? { apiKey } : {}),
        });
        built = compatible(model);
        break;
      }
      default:
        // Unreachable: resolveUsableModelConfig rejects other providers.
        throw new AgentConfigurationError(
          `Unsupported provider '${provider}'.`,
        );
    }

    this.cache.set(cacheKey, built);
    return built;
  }
}
