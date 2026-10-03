import {
  AgentConfigurationError,
  ModelProviderFactory,
} from './model-provider.factory';
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

/** A per-skill override that sets only the given fields. */
const override = (
  fields: Partial<AgentSettings['skillModels'][string]>,
): AgentSettings['skillModels'][string] => ({
  provider: null,
  model: null,
  apiKey: null,
  baseUrl: null,
  reasoningEffort: null,
  ...fields,
});

/** The request a real SDK model would send, captured by a stubbed fetch. */
interface SentRequest {
  url: string;
  authorization: string | null;
}

/**
 * Lets a model built by the real provider package send one request and
 * captures it. The SDK reads `globalThis.fetch` per call, so the stub answers
 * every request and nothing leaves the process.
 */
async function requestSentBy(model: unknown): Promise<SentRequest> {
  const sent: SentRequest[] = [];
  const fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation((input, init) => {
      sent.push({
        url: input instanceof Request ? input.url : String(input),
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return Promise.resolve(new Response('{}', { status: 400 }));
    });
  try {
    await (model as { doGenerate(options: unknown): Promise<unknown> })
      .doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })
      .catch(() => undefined);
  } finally {
    fetchSpy.mockRestore();
  }
  expect(sent).toHaveLength(1);
  return sent[0];
}

/** Lets the mocked `@ai-sdk/openai` build real models. */
const useRealOpenAI = (): void => {
  const actual =
    jest.requireActual<typeof import('@ai-sdk/openai')>('@ai-sdk/openai');
  createOpenAIMock.mockImplementation(actual.createOpenAI);
};

/** Never reached (fetch is stubbed); keeps a broken stub off the real API. */
const UNREACHABLE_BASE_URL = 'http://127.0.0.1:9/v1';

describe('ModelProviderFactory.getModel', () => {
  beforeEach(() => createOpenAIMock.mockReset());

  it('throws when the provider is not configured', async () => {
    await expect(makeFactory({ provider: null }).getModel()).rejects.toThrow(
      AgentConfigurationError,
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

  it('builds a separate model per API key when skills share a model', async () => {
    useRealOpenAI();
    const factory = makeFactory({
      provider: 'openai',
      model: 'shared-model',
      apiKey: 'sk-global',
      baseUrl: UNREACHABLE_BASE_URL,
      skillModels: {
        link_purpose: override({ apiKey: 'sk-link' }),
        page_title: override({ apiKey: 'sk-title' }),
      },
    });

    const link = await factory.getModel('link_purpose');
    const title = await factory.getModel('page_title');

    expect(link).not.toBe(title);
    expect((await requestSentBy(link)).authorization).toBe('Bearer sk-link');
    expect((await requestSentBy(title)).authorization).toBe('Bearer sk-title');
    // Skills with the same key still share one model.
    expect(await factory.getModel('link_purpose')).toBe(link);
  });

  describe('per-skill overrides and the global key and base URL', () => {
    const LOCAL_ENDPOINT = 'http://127.0.0.1:9/v1';

    it('does not send the global key to an endpoint of another provider', async () => {
      // A key-less local server for one skill, OpenAI for the rest.
      const factory = makeFactory({
        provider: 'openai',
        model: 'gpt-test',
        apiKey: 'sk-openai-secret',
        baseUrl: null,
        skillModels: {
          link_purpose: override({
            provider: 'openai-compatible',
            model: 'llama3.2',
            baseUrl: LOCAL_ENDPOINT,
          }),
        },
      });

      expect(factory.resolveModelConfig('link_purpose')).toMatchObject({
        apiKey: null,
        baseUrl: LOCAL_ENDPOINT,
      });
      const sent = await requestSentBy(await factory.getModel('link_purpose'));
      expect(sent.url.startsWith(LOCAL_ENDPOINT)).toBe(true);
      expect(sent.authorization).toBeNull();
    });

    it('does not send the global key to a skill-specific base URL', async () => {
      const factory = makeFactory({
        provider: 'openai-compatible',
        model: 'anthropic/claude-haiku-4.5',
        apiKey: 'sk-or-secret',
        baseUrl: 'https://openrouter.ai/api/v1',
        skillModels: {
          page_title: override({ model: 'llama3.2', baseUrl: LOCAL_ENDPOINT }),
        },
      });

      expect(factory.resolveModelConfig('page_title').apiKey).toBeNull();
      const sent = await requestSentBy(await factory.getModel('page_title'));
      expect(sent.url.startsWith(LOCAL_ENDPOINT)).toBe(true);
      expect(sent.authorization).toBeNull();
    });

    it('sends the global key to an override base URL that is the global endpoint', async () => {
      // The same endpoint written with a trailing slash and an upper-case
      // scheme and host, as operators copy it between variables.
      for (const sameEndpoint of [
        `${LOCAL_ENDPOINT}/`,
        'HTTP://127.0.0.1:9/v1',
        'http://127.0.0.1:9/v1//',
      ]) {
        const factory = makeFactory({
          provider: 'openai-compatible',
          model: 'llama3.2',
          apiKey: 'sk-gateway',
          baseUrl: LOCAL_ENDPOINT,
          skillModels: {
            page_title: override({ model: 'small', baseUrl: sameEndpoint }),
          },
        });

        expect(factory.resolveModelConfig('page_title').apiKey).toBe(
          'sk-gateway',
        );
        const sent = await requestSentBy(await factory.getModel('page_title'));
        expect(sent.url.startsWith(LOCAL_ENDPOINT)).toBe(true);
        expect(sent.authorization).toBe('Bearer sk-gateway');
      }
    });

    it('does not send the global key to a base URL that only resembles the global one', () => {
      for (const otherEndpoint of [
        'http://127.0.0.1:9/V1', // paths are case-sensitive
        'http://127.0.0.1:9/v1/chat',
        'http://127.0.0.1:9/v2',
        'http://127.0.0.1:10/v1',
        'https://127.0.0.1:9/v1',
        'http://localhost:9/v1',
        'http://127.0.0.1:9@attacker.example/v1',
        'http://127.0.0.1:9/v1?key=1',
        'not a url',
      ]) {
        const factory = makeFactory({
          provider: 'openai-compatible',
          model: 'llama3.2',
          apiKey: 'sk-gateway',
          baseUrl: LOCAL_ENDPOINT,
          skillModels: {
            page_title: override({ model: 'small', baseUrl: otherEndpoint }),
          },
        });

        expect(factory.resolveModelConfig('page_title')).toMatchObject({
          apiKey: null,
          baseUrl: otherEndpoint,
        });
      }
    });

    it('does not send the global key to the same base URL under another provider', () => {
      const factory = makeFactory({
        provider: 'openai',
        model: 'gpt-test',
        apiKey: 'sk-openai-secret',
        baseUrl: LOCAL_ENDPOINT,
        skillModels: {
          link_purpose: override({
            provider: 'openai-compatible',
            model: 'llama3.2',
            baseUrl: LOCAL_ENDPOINT,
          }),
        },
      });

      expect(factory.resolveModelConfig('link_purpose').apiKey).toBeNull();
    });

    it('does not use the global base URL for another provider', () => {
      const factory = makeFactory({
        provider: 'openai-compatible',
        model: 'deepseek-chat',
        apiKey: 'sk-deepseek',
        baseUrl: 'https://api.deepseek.com',
        skillModels: {
          image_alt_text: override({ provider: 'openai', apiKey: 'sk-openai' }),
        },
      });

      expect(factory.resolveModelConfig('image_alt_text')).toMatchObject({
        provider: 'openai',
        apiKey: 'sk-openai',
        baseUrl: null,
      });
    });

    it('inherits both when the override keeps the provider and endpoint', () => {
      const factory = makeFactory({
        provider: 'openai-compatible',
        model: 'deepseek-chat',
        apiKey: 'sk-deepseek',
        baseUrl: 'https://api.deepseek.com',
        skillModels: {
          // Naming the same provider explicitly is not a switch.
          link_purpose: override({
            provider: 'openai-compatible',
            model: 'deepseek-reasoner',
          }),
        },
      });

      expect(factory.resolveModelConfig('link_purpose')).toMatchObject({
        apiKey: 'sk-deepseek',
        baseUrl: 'https://api.deepseek.com',
      });
    });

    it('names only the per-skill key when the global key is not inherited', () => {
      const factory = makeFactory({
        provider: 'openai',
        model: 'gpt-test',
        apiKey: 'sk-openai',
        skillModels: {
          image_alt_text: override({ provider: 'anthropic', model: 'claude' }),
        },
      });

      expect(() => factory.resolveUsableModelConfig('image_alt_text')).toThrow(
        /AGENT_SKILL_IMAGE_ALT_TEXT_API_KEY/,
      );
      expect(() =>
        factory.resolveUsableModelConfig('image_alt_text'),
      ).not.toThrow(/set AGENT_API_KEY/);
    });
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
