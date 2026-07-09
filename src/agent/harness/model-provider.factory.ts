import {
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import type { LanguageModel } from 'ai';
import { agentConfig, AgentModelConfig } from '../../config/configuration';

/** A fully-resolved model configuration (skill override merged over defaults). */
export interface ResolvedModelConfig {
  provider: string;
  model: string;
  apiKey: string | null;
  baseUrl: string | null;
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
   * Resolves the effective model config for a skill: its per-skill override
   * (`AGENT_SKILL_<ID>_*`) merged over the global `AGENT_*` defaults. Passing no
   * skill returns the global default. Throws when provider/model are unset.
   */
  resolveModelConfig(skill?: string): ResolvedModelConfig {
    const override: AgentModelConfig | undefined = skill
      ? this.config.skillModels[skill]
      : undefined;

    const provider = override?.provider ?? this.config.provider;
    const model = override?.model ?? this.config.model;
    if (!provider) {
      throw new InternalServerErrorException(
        `AGENT_PROVIDER is not configured${skill ? ` for skill ${skill}` : ''}.`,
      );
    }
    if (!model) {
      throw new InternalServerErrorException(
        `AGENT_MODEL is not configured${skill ? ` for skill ${skill}` : ''}.`,
      );
    }
    return {
      provider,
      model,
      apiKey: override?.apiKey ?? this.config.apiKey,
      baseUrl: override?.baseUrl ?? this.config.baseUrl,
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
