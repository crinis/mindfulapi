import { agentConfig, appConfig, redisConfig } from './configuration';
import { ScanMode } from '../enums/scan-mode.enum';

describe('agentConfig allowed scan modes', () => {
  const originalAllowedScanModes = process.env.AGENT_ALLOWED_SCAN_MODES;

  afterEach(() => {
    if (originalAllowedScanModes === undefined) {
      delete process.env.AGENT_ALLOWED_SCAN_MODES;
    } else {
      process.env.AGENT_ALLOWED_SCAN_MODES = originalAllowedScanModes;
    }
  });

  it.each([undefined, '', '   '])('defaults %p to single_url', (configured) => {
    if (configured === undefined) {
      delete process.env.AGENT_ALLOWED_SCAN_MODES;
    } else {
      process.env.AGENT_ALLOWED_SCAN_MODES = configured;
    }

    expect(agentConfig().allowedScanModes).toEqual([ScanMode.SINGLE_URL]);
  });

  it('trims and deduplicates configured scan modes', () => {
    process.env.AGENT_ALLOWED_SCAN_MODES =
      ' crawl, single_url, crawl, url_list ';

    expect(agentConfig().allowedScanModes).toEqual([
      ScanMode.CRAWL,
      ScanMode.SINGLE_URL,
      ScanMode.URL_LIST,
    ]);
  });
});

/**
 * The environment validation treats an empty value as unset, so every config
 * namespace must give an empty value the same meaning as an unset one.
 */
describe('empty values mean unset', () => {
  const names = [
    'AGENT_SKILLS',
    'AGENT_PROVIDER',
    'REDIS_PASSWORD',
    'CORS_ORIGINS',
    'NODE_ENV',
  ];
  const original = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );

  afterEach(() => {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });

  function readWith(value: string | undefined) {
    for (const name of names) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return {
      agent: agentConfig(),
      app: appConfig(),
      redis: redisConfig(),
    };
  }

  it('reads an empty value exactly like an unset one', () => {
    const empty = readWith('');
    const unset = readWith(undefined);

    expect(empty.agent.allowedSkills).toEqual(unset.agent.allowedSkills);
    expect(empty.agent.allowedSkills).toHaveLength(5);
    expect(empty.agent.provider).toBeNull();
    expect(empty.redis.password).toBeUndefined();
    expect(empty.app.corsOrigins).toEqual([]);
    expect(empty.app.nodeEnv).toBe(unset.app.nodeEnv);
  });
});
