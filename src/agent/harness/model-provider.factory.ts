import {
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import type { LanguageModel } from 'ai';
import { agentConfig } from '../../config/configuration';

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
  private cached?: LanguageModel;

  constructor(
    @Inject(agentConfig.KEY)
    private readonly config: ConfigType<typeof agentConfig>,
  ) {}

  /**
   * Builds (and caches) the configured language model, throwing a readable
   * error when required settings are missing.
   */
  async getModel(): Promise<LanguageModel> {
    if (this.cached) {
      return this.cached;
    }

    const { provider, model, apiKey, baseUrl } = this.config;
    if (!provider) {
      throw new InternalServerErrorException(
        'AGENT_PROVIDER is not configured.',
      );
    }
    if (!model) {
      throw new InternalServerErrorException('AGENT_MODEL is not configured.');
    }

    switch (provider) {
      case 'openai': {
        const { createOpenAI } = await import('@ai-sdk/openai');
        const openai = createOpenAI({
          apiKey: this.requireApiKey(apiKey, provider),
          ...(baseUrl ? { baseURL: baseUrl } : {}),
        });
        this.cached = openai(model);
        break;
      }
      case 'anthropic': {
        const { createAnthropic } = await import('@ai-sdk/anthropic');
        const anthropic = createAnthropic({
          apiKey: this.requireApiKey(apiKey, provider),
          ...(baseUrl ? { baseURL: baseUrl } : {}),
        });
        this.cached = anthropic(model);
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
        this.cached = compatible(model);
        break;
      }
      default:
        throw new InternalServerErrorException(
          `Unsupported AGENT_PROVIDER: ${provider}`,
        );
    }

    return this.cached;
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
