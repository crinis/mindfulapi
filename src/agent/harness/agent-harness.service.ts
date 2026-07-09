import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import type { ToolSet, UserContent } from 'ai';
import type { z } from 'zod';
import { agentConfig } from '../../config/configuration';
import { ModelProviderFactory } from './model-provider.factory';

// `ai` is ESM-only; import it lazily inside the methods so it stays out of the
// CommonJS module-load graph until an audit actually runs.

/** Token usage returned alongside every harness call. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** An image attached to a structured request (element screenshot). */
export interface HarnessImage {
  /** Raw image bytes. */
  data: Buffer;
  /** IANA media type, e.g. `image/png`. */
  mediaType: string;
}

/** Parameters for a single structured-output request. */
export interface StructuredRequest<T> {
  /** System prompt establishing the task and rubric. */
  system: string;
  /** User prompt carrying the structured evidence. */
  prompt: string;
  /** Optional images (element screenshots) to include as vision input. */
  images?: HarnessImage[];
  /** Zod schema the model output must satisfy. */
  schema: z.ZodType<T>;
  /**
   * Value returned when generation or validation fails after the retry — keeps
   * a single flaky/weak-model request from failing the whole scan. Skills pass
   * their `insufficient_evidence` verdict here.
   */
  fallback: T;
  /**
   * Skill id, used to select a per-skill model override
   * (`AGENT_SKILL_<ID>_*`); omit to use the global default model.
   */
  skill?: string;
}

/** Result of a harness call, including usage and a degraded-output flag. */
export interface HarnessResult<T> {
  data: T;
  usage: TokenUsage;
  /** Resolved model identifier that produced (or would produce) the output. */
  model: string;
  /** True when {@link StructuredRequest.fallback} was returned. */
  degraded: boolean;
}

/**
 * Thin, provider-agnostic wrapper over the Vercel AI SDK that centralizes the
 * cross-cutting concerns every skill needs: forced structured output, vision
 * encoding, per-request token/temperature/timeout limits, a single repair
 * retry, graceful fallback, and token-usage accounting.
 */
@Injectable()
export class AgentHarnessService {
  private readonly logger = new Logger(AgentHarnessService.name);

  constructor(
    private readonly providerFactory: ModelProviderFactory,
    @Inject(agentConfig.KEY)
    private readonly config: ConfigType<typeof agentConfig>,
  ) {}

  /**
   * Runs one structured-output request (the low-hallucination path used by
   * per-unit skills). The model is forced to satisfy `schema`; on failure the
   * AI SDK retries once and, if still invalid, the caller's `fallback` is
   * returned with a `degraded` flag rather than throwing.
   */
  async evaluateStructured<T>(
    request: StructuredRequest<T>,
  ): Promise<HarnessResult<T>> {
    const content: UserContent = [{ type: 'text', text: request.prompt }];
    for (const image of request.images ?? []) {
      if (image.data.byteLength > this.config.maxImageBytes) {
        this.logger.warn(
          `Skipping oversized image (${image.data.byteLength} bytes > ${this.config.maxImageBytes}).`,
        );
        continue;
      }
      content.push({
        type: 'image',
        image: image.data,
        mediaType: image.mediaType,
      });
    }

    const modelId = this.providerFactory.resolveModelConfig(
      request.skill,
    ).model;

    try {
      const { generateObject } = await import('ai');
      const result = await generateObject({
        model: await this.providerFactory.getModel(request.skill),
        schema: request.schema,
        system: request.system,
        messages: [{ role: 'user', content }],
        maxOutputTokens: this.config.perTaskMaxTokens,
        temperature: this.config.temperature,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
      return {
        data: result.object,
        usage: this.normalizeUsage(result.usage),
        model: modelId,
        degraded: false,
      };
    } catch (error) {
      this.logger.warn(
        `Structured generation failed; returning fallback: ${String(error)}`,
      );
      return {
        data: request.fallback,
        usage: { inputTokens: 0, outputTokens: 0 },
        model: modelId,
        degraded: true,
      };
    }
  }

  /**
   * Multi-step tool-calling loop. Reserved for future open-ended skills that
   * must gather more evidence dynamically; no current skill uses it, so it is
   * kept intentionally minimal.
   */
  async runAgent(request: {
    system: string;
    prompt: string;
    tools: ToolSet;
    maxSteps?: number;
    skill?: string;
  }): Promise<{ text: string; usage: TokenUsage }> {
    const { generateText, stepCountIs } = await import('ai');
    const result = await generateText({
      model: await this.providerFactory.getModel(request.skill),
      system: request.system,
      prompt: request.prompt,
      tools: request.tools,
      stopWhen: stepCountIs(request.maxSteps ?? 4),
      maxOutputTokens: this.config.perTaskMaxTokens,
      temperature: this.config.temperature,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    return { text: result.text, usage: this.normalizeUsage(result.usage) };
  }

  /** Normalizes the SDK usage object into defined integer token counts. */
  private normalizeUsage(usage: {
    inputTokens?: number;
    outputTokens?: number;
  }): TokenUsage {
    return {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    };
  }
}
