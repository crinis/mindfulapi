import { z } from 'zod';
import { AgentHarnessService } from './agent-harness.service';
import { ModelProviderFactory } from './model-provider.factory';
import { agentConfig } from '../../config/configuration';

const generateObjectMock = jest.fn();
jest.mock('ai', () => ({
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
  generateText: jest.fn(),
  stepCountIs: jest.fn(),
}));

const schema = z.object({ verdict: z.string() });
const fallback = { verdict: 'insufficient_evidence' };

describe('AgentHarnessService.evaluateStructured', () => {
  let service: AgentHarnessService;
  let providerFactory: { getModel: jest.Mock; resolveModelConfig: jest.Mock };

  beforeEach(() => {
    generateObjectMock.mockReset();
    providerFactory = {
      getModel: jest.fn().mockResolvedValue({ id: 'model' }),
      resolveModelConfig: jest.fn().mockReturnValue({
        provider: 'openai',
        model: 'gpt-test',
        apiKey: 'sk',
        baseUrl: null,
        reasoningEffort: null,
      }),
    };
    service = new AgentHarnessService(
      providerFactory as unknown as ModelProviderFactory,
      agentConfig(),
    );
  });

  it('returns parsed data and normalized usage on success', async () => {
    generateObjectMock.mockResolvedValue({
      object: { verdict: 'appropriate' },
      usage: { inputTokens: 42, outputTokens: 7 },
    });

    const result = await service.evaluateStructured({
      system: 'sys',
      prompt: 'p',
      schema,
      fallback,
    });

    expect(result.data).toEqual({ verdict: 'appropriate' });
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
    expect(result.degraded).toBe(false);
  });

  it('returns the fallback (degraded) when generation throws', async () => {
    generateObjectMock.mockRejectedValue(new Error('bad json'));

    const result = await service.evaluateStructured({
      system: 'sys',
      prompt: 'p',
      schema,
      fallback,
    });

    expect(result.data).toBe(fallback);
    expect(result.degraded).toBe(true);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('normalizes missing usage counts to zero', async () => {
    generateObjectMock.mockResolvedValue({
      object: { verdict: 'appropriate' },
      usage: {},
    });

    const result = await service.evaluateStructured({
      system: 'sys',
      prompt: 'p',
      schema,
      fallback,
    });

    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('sends temperature (and no reasoning effort) for a sampling model', async () => {
    generateObjectMock.mockResolvedValue({
      object: { verdict: 'appropriate' },
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    await service.evaluateStructured({
      system: 'sys',
      prompt: 'p',
      schema,
      fallback,
    });

    const call = generateObjectMock.mock.calls[0][0] as {
      temperature?: number;
      providerOptions?: unknown;
    };
    expect(call.temperature).toBe(agentConfig().temperature);
    expect(call.providerOptions).toBeUndefined();
  });

  it('sends reasoning effort and omits temperature for a reasoning model', async () => {
    providerFactory.resolveModelConfig.mockReturnValue({
      provider: 'openai',
      model: 'gpt-5.4-mini',
      apiKey: 'sk',
      baseUrl: null,
      reasoningEffort: 'low',
    });
    generateObjectMock.mockResolvedValue({
      object: { verdict: 'appropriate' },
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    await service.evaluateStructured({
      system: 'sys',
      prompt: 'p',
      schema,
      fallback,
    });

    const call = generateObjectMock.mock.calls[0][0] as {
      temperature?: number;
      providerOptions?: { openai?: { reasoningEffort?: string } };
    };
    expect(call.temperature).toBeUndefined();
    expect(call.providerOptions?.openai?.reasoningEffort).toBe('low');
  });

  it('drops oversized images before sending them to the model', async () => {
    generateObjectMock.mockResolvedValue({
      object: { verdict: 'appropriate' },
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const big = Buffer.alloc(agentConfig().maxImageBytes + 1);

    await service.evaluateStructured({
      system: 'sys',
      prompt: 'p',
      images: [{ data: big, mediaType: 'image/png' }],
      schema,
      fallback,
    });

    const call = generateObjectMock.mock.calls[0][0] as {
      messages: { content: { type: string }[] }[];
    };
    const parts = call.messages[0].content;
    expect(parts.some((part) => part.type === 'image')).toBe(false);
  });
});
