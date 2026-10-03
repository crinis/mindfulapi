import 'reflect-metadata';
import { getMetadataStorage } from 'class-validator';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseEnv } from 'util';
import { EnvironmentVariables, validate } from './env.validation';

/**
 * The environment the API container receives from `docker compose config`
 * with the shipped `.env.example` copied to `.env` (env_file + the pinned
 * `environment:` entries). Regenerate after changing docker-compose.yml or
 * .env.example: copy both into an empty directory, rename .env.example to .env
 * and run `docker compose config --format json` there.
 */
const COMPOSE_ENV_FROM_ENV_EXAMPLE: Record<string, string> = {
  AGENT_ALLOWED_SCAN_MODES: 'single_url',
  AGENT_ENABLED: 'false',
  AUTH_TOKEN: 'your-secure-api-token-here',
  CLEANUP_ENABLED: 'true',
  CLEANUP_INTERVAL: '0 2 * * *',
  CLEANUP_RETENTION_DAYS: '30',
  CRAWL_CONCURRENCY: '4',
  DATABASE_PATH: '/data/database.sqlite',
  IGNORE_HTTPS_ERRORS: 'false',
  NODE_ENV: 'production',
  PLAYWRIGHT_WS_URL: 'ws://playwright:3000',
  PORT: '3000',
  REDIS_HOST: 'redis',
  REDIS_PASSWORD: '',
  REDIS_PORT: '6379',
};

/**
 * What docker-compose.yml rendered before its `${VAR:-}` passthrough entries
 * were removed: an unset AGENT_PROVIDER arrived as an empty string.
 */
const LEGACY_COMPOSE_PASSTHROUGH: Record<string, string> = {
  ...COMPOSE_ENV_FROM_ENV_EXAMPLE,
  AGENT_PROVIDER: '',
  AGENT_MODEL: '',
  AGENT_API_KEY: '',
  AGENT_BASE_URL: '',
  AGENT_SKILLS: '',
  ENCRYPTION_KEY: '',
};

const ENV_EXAMPLE = readFileSync(
  join(__dirname, '..', '..', '.env.example'),
  'utf8',
);

/** .env.example with every commented `# NAME=value` line uncommented. */
function uncommentedEnvExample(emptyValues: boolean): Record<string, string> {
  const lines = ENV_EXAMPLE.split('\n').map((line) => {
    const match = /^#\s?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) return line;
    return emptyValues ? `${match[1]}=` : `${match[1]}=${match[2]}`;
  });
  return parseEnv(lines.join('\n')) as Record<string, string>;
}

/** Every variable the schema declares. */
function declaredVariables(): string[] {
  const names = getMetadataStorage()
    .getTargetValidationMetadatas(EnvironmentVariables, '', true, false)
    .map((metadata) => metadata.propertyName);
  return [...new Set(names)];
}

describe('env validation', () => {
  it('accepts an empty environment (all vars optional)', () => {
    expect(() => validate({})).not.toThrow();
  });

  it('accepts a typical production configuration', () => {
    expect(() =>
      validate({
        NODE_ENV: 'production',
        PORT: '3000',
        AUTH_TOKEN: 'secret',
        REDIS_HOST: 'redis',
        REDIS_PORT: '6379',
        CLEANUP_ENABLED: 'true',
        CLEANUP_RETENTION_DAYS: '30',
        CRAWL_CONCURRENCY: '4',
        AGENT_ALLOWED_SCAN_MODES: 'single_url, url_list, crawl',
      }),
    ).not.toThrow();
  });

  it('accepts a blank AI-audit scan-mode allowlist for defaulting', () => {
    expect(() => validate({ AGENT_ALLOWED_SCAN_MODES: '  ' })).not.toThrow();
  });

  it('rejects an unknown AI-audit scan mode', () => {
    expect(() =>
      validate({ AGENT_ALLOWED_SCAN_MODES: 'single_url,site_crawl' }),
    ).toThrow(/AGENT_ALLOWED_SCAN_MODES/);
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => validate({ PORT: 'not-a-port' })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('rejects an out-of-range CRAWL_CONCURRENCY', () => {
    expect(() => validate({ CRAWL_CONCURRENCY: '99' })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('rejects non-boolean AUTH_DISABLED values', () => {
    expect(() => validate({ AUTH_DISABLED: 'yes' })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('ignores unrelated environment variables', () => {
    expect(() => validate({ SOME_OTHER_TOOL_VAR: 'anything' })).not.toThrow();
  });

  describe('empty values', () => {
    it('accepts the environment docker compose renders from .env.example', () => {
      expect(() => validate(COMPOSE_ENV_FROM_ENV_EXAMPLE)).not.toThrow();
    });

    it('accepts the empty values of the old compose passthrough', () => {
      expect(() => validate(LEGACY_COMPOSE_PASSTHROUGH)).not.toThrow();
    });

    it('accepts .env.example as npm start and the config module parse it', () => {
      expect(() => validate(parseEnv(ENV_EXAMPLE))).not.toThrow();
    });

    it('accepts .env.example with every commented example uncommented', () => {
      expect(() => validate(uncommentedEnvExample(false))).not.toThrow();
    });

    it('accepts .env.example with every commented variable left empty', () => {
      const env = uncommentedEnvExample(true);
      expect(env).toHaveProperty('AGENT_REASONING_EFFORT', '');
      expect(env).toHaveProperty('AGENT_PROVIDER', '');
      expect(() => validate(env)).not.toThrow();
    });

    it.each(declaredVariables())('treats an empty %s as unset', (name) => {
      expect(() => validate({ [name]: '' })).not.toThrow();
      expect(
        (validate({ [name]: '' }) as unknown as Record<string, unknown>)[name],
      ).toBeUndefined();
    });

    it('still validates the non-empty values next to empty ones', () => {
      expect(() =>
        validate({ AGENT_PROVIDER: '', AGENT_REASONING_EFFORT: 'extreme' }),
      ).toThrow(/AGENT_REASONING_EFFORT/);
    });
  });
});
