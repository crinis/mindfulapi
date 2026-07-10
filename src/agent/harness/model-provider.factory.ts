import {
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
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
 * Configuration is validated lazily on first use (mirroring
 * {@link BasicAuthCryptoService}) so the app boots without provider
 * credentials whenever the AI audit is disabled.
 */
@Injectable()
export class ModelProviderFactory {
  /** Built models cached per resolved config (provider|model|baseUrl). */
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
   * no skill returns the provider default. Throws when provider/model are unset.
   */
  resolveModelConfig(skill?: string): ResolvedModelConfig {
    const override: AgentModelConfig | undefined = skill
      ? this.config.skillModels[skill]
      : undefined;

    const provider = override?.provider ?? this.config.provider;
    if (!provider) {
      throw new InternalServerErrorException(
        `AGENT_PROVIDER is not configured${skill ? ` for skill ${skill}` : ''}.`,
      );
    }
    // The profile only supplies the model when neither the per-skill env nor the
    // global AGENT_MODEL does; its reasoning effort is used only in that case.
    const usesProfileModel = !override?.model && !this.config.model;
    const profile = resolveProfileEntry(provider, skill);
    const model =
      override?.model ?? this.config.model ?? profile?.model ?? null;
    if (!model) {
      throw new InternalServerErrorException(
        `No model configured for skill ${skill ?? '(default)'}: set AGENT_MODEL, ` +
          `AGENT_SKILL_${(skill ?? '').toUpperCase()}_MODEL, or use a provider with a built-in profile.`,
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
   * Builds (and caches) the language model for a skill (or the global default),
   * throwing a readable error when required settings are missing.
   */
  async getModel(skill?: string): Promise<LanguageModel> {
    const { provider, model, apiKey, baseUrl } = this.resolveModelConfig(skill);
    const cacheKey = `${provider}|${model}|${baseUrl ?? ''}`;
    const existing = this.cache.get(cacheKey);
    if (existing) {
      return existing;
    }

    let built: LanguageModel;
    switch (provider) {
      case 'openai': {
        const { createOpenAI } = await import('@ai-sdk/openai');
        const openai = createOpenAI({
          apiKey: this.requireApiKey(apiKey, provider),
          ...(baseUrl ? { baseURL: baseUrl } : {}),
        });
        built = openai(model);
        break;
      }
      case 'anthropic': {
        const { createAnthropic } = await import('@ai-sdk/anthropic');
        const anthropic = createAnthropic({
          apiKey: this.requireApiKey(apiKey, provider),
          ...(baseUrl ? { baseURL: baseUrl } : {}),
        });
        built = anthropic(model);
        break;
      }
      case 'openai-compatible': {
        if (!baseUrl) {
          throw new InternalServerErrorException(
            'AGENT_BASE_URL is required for the openai-compatible provider.',
          );
        }
        const { createOpenAICompatible } =
          await import('@ai-sdk/openai-compatible');
        const compatible = createOpenAICompatible({
          name: 'agent',
          baseURL: baseUrl,
          ...(apiKey ? { apiKey } : {}),
        });
        built = compatible(model);
        break;
      }
      default:
        throw new InternalServerErrorException(
          `Unsupported AGENT_PROVIDER: ${provider}`,
        );
    }

    this.cache.set(cacheKey, built);
    return built;
  }

  /** Returns the API key or throws when a provider requires one. */
  private requireApiKey(apiKey: string | null, provider: string): string {
    if (!apiKey) {
      throw new InternalServerErrorException(
        `AGENT_API_KEY is required for the ${provider} provider.`,
      );
    }
    return apiKey;
  }
}
