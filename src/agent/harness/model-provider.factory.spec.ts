import { InternalServerErrorException } from '@nestjs/common';
import { ModelProviderFactory } from './model-provider.factory';
import { agentConfig } from '../../config/configuration';

const createOpenAIMock = jest.fn();
jest.mock('@ai-sdk/openai', () => ({
  createOpenAI: (...args: unknown[]) => createOpenAIMock(...args),
}));

type AgentSettings = ReturnType<typeof agentConfig>;

const settings = (overrides: Partial<AgentSettings>): AgentSettings => ({
  ...agentConfig(),
  ...overrides,
});

const makeFactory = (overrides: Partial<AgentSettings>): ModelProviderFactory =>
  new ModelProviderFactory(settings(overrides));

describe('ModelProviderFactory.getModel', () => {
  beforeEach(() => createOpenAIMock.mockReset());

  it('throws when the provider is not configured', async () => {
    await expect(makeFactory({ provider: null }).getModel()).rejects.toThrow(
      InternalServerErrorException,
    );
  });

  it('throws when the model is not configured', async () => {
    await expect(
      makeFactory({ provider: 'openai', model: null }).getModel(),
    ).rejects.toThrow(/AGENT_MODEL/);
  });

  it('throws when the openai provider has no API key', async () => {
    await expect(
      makeFactory({
        provider: 'openai',
        model: 'gpt',
        apiKey: null,
      }).getModel(),
    ).rejects.toThrow(/AGENT_API_KEY/);
  });

  it('throws when openai-compatible has no base URL', async () => {
    await expect(
      makeFactory({
        provider: 'openai-compatible',
        model: 'llama',
        baseUrl: null,
      }).getModel(),
    ).rejects.toThrow(/AGENT_BASE_URL/);
  });

  it('builds and caches an openai model', async () => {
    const model = { id: 'gpt-4o-mini' };
    createOpenAIMock.mockReturnValue(() => model);
    const factory = makeFactory({
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
    });

    const first = await factory.getModel();
    const second = await factory.getModel();

    expect(first).toBe(model);
    expect(second).toBe(model);
    expect(createOpenAIMock).toHaveBeenCalledTimes(1); // cached
  });
});
