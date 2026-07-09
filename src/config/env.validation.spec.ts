import 'reflect-metadata';
import { validate } from './env.validation';

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
      }),
    ).not.toThrow();
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
});
