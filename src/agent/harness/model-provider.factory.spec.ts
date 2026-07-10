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

  it('throws when the model is not configured and the provider has no profile', async () => {
    await expect(
      makeFactory({ provider: 'anthropic', model: null }).getModel(),
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

  it('applies a per-skill model override merged over the defaults', () => {
    const factory = makeFactory({
      provider: 'openai',
      model: 'default-model',
      apiKey: 'sk-default',
      skillModels: {
        image_alt_text: {
          provider: null, // inherit openai
          model: 'skill-model',
          apiKey: 'sk-skill',
          baseUrl: null,
          reasoningEffort: null,
        },
      },
    });

    expect(factory.resolveModelConfig('image_alt_text')).toEqual({
      provider: 'openai',
      model: 'skill-model',
      apiKey: 'sk-skill',
      baseUrl: null,
      reasoningEffort: null,
    });
    // No override falls back entirely to the defaults.
    expect(factory.resolveModelConfig().model).toBe('default-model');
    expect(factory.resolveModelConfig('unknown_skill').model).toBe(
      'default-model',
    );
  });

  describe('provider model profiles', () => {
    it('uses the OpenAI profile per-skill models when no model is configured', () => {
      // Provider selected, but AGENT_MODEL unset and no per-skill env override:
      // each skill falls back to its tuned profile model.
      const factory = makeFactory({
        provider: 'openai',
        model: null,
        apiKey: 'sk-default',
        skillModels: {},
      });

      // Text-only semantic skills run on the cheapest tier at `none` effort…
      expect(factory.resolveModelConfig('page_title')).toMatchObject({
        model: 'gpt-5.4-nano',
        reasoningEffort: 'none',
      });
      expect(factory.resolveModelConfig('link_purpose').model).toBe(
        'gpt-5.4-nano',
      );
      // …the structural-reasoning skill takes a reasoning effort…
      expect(factory.resolveModelConfig('heading_structure')).toMatchObject({
        model: 'gpt-5.4-mini',
        reasoningEffort: 'low',
      });
      expect(factory.resolveModelConfig('form_labels').model).toBe(
        'gpt-5.4-nano',
      );
      // …the vision skill takes the mini tier…
      expect(factory.resolveModelConfig('image_alt_text').model).toBe(
        'gpt-5.4-mini',
      );
      // …and an unlisted/default lookup uses the profile default.
      expect(factory.resolveModelConfig().model).toBe('gpt-5.4-mini');
    });

    it('lets an explicit AGENT_MODEL override the profile for every skill', () => {
      const factory = makeFactory({
        provider: 'openai',
        model: 'forced-model',
        apiKey: 'sk-default',
        skillModels: {},
      });
      expect(factory.resolveModelConfig('page_title').model).toBe(
        'forced-model',
      );
      expect(factory.resolveModelConfig('image_alt_text').model).toBe(
        'forced-model',
      );
      // A forced model is not a profile reasoning model, so no effort leaks in.
      expect(factory.resolveModelConfig('heading_structure')).toMatchObject({
        model: 'forced-model',
        reasoningEffort: null,
      });
    });

    it('lets a per-skill env override beat both the profile and AGENT_MODEL', () => {
      const factory = makeFactory({
        provider: 'openai',
        model: 'forced-model',
        apiKey: 'sk-default',
        skillModels: {
          page_title: {
            provider: null,
            model: 'per-skill-model',
            apiKey: null,
            baseUrl: null,
            reasoningEffort: null,
          },
        },
      });
      expect(factory.resolveModelConfig('page_title').model).toBe(
        'per-skill-model',
      );
      // Other skills still follow AGENT_MODEL.
      expect(factory.resolveModelConfig('heading_structure').model).toBe(
        'forced-model',
      );
    });
  });

  it('resolves a distinct model per skill in one configuration', () => {
    const factory = makeFactory({
      provider: 'openai',
      model: 'shared-default',
      apiKey: 'sk-default',
      skillModels: {
        image_alt_text: {
          provider: null,
          model: 'vision-model',
          apiKey: null,
          baseUrl: null,
          reasoningEffort: null,
        },
        heading_structure: {
          provider: null,
          model: 'cheap-text-model',
          apiKey: null,
          baseUrl: null,
          reasoningEffort: null,
        },
      },
    });

    expect(factory.resolveModelConfig('image_alt_text').model).toBe(
      'vision-model',
    );
    expect(factory.resolveModelConfig('heading_structure').model).toBe(
      'cheap-text-model',
    );
  });
});
