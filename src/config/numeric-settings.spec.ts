import 'reflect-metadata';
import {
  agentConfig,
  appConfig,
  cleanupConfig,
  redisConfig,
  scanConfig,
  securityConfig,
} from './configuration';
import { validate } from './env.validation';
import {
  DECIMAL_SETTINGS,
  INTEGER_SETTINGS,
  readDecimalSetting,
  readIntSetting,
} from './numeric-settings';

const NAMES = [
  ...Object.keys(INTEGER_SETTINGS),
  ...Object.keys(DECIMAL_SETTINGS),
];
const original = Object.fromEntries(
  NAMES.map((name) => [name, process.env[name]]),
);

afterEach(() => {
  for (const name of NAMES) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
});

/** Every value env validation accepts must be used unchanged. */
describe.each(Object.entries(INTEGER_SETTINGS))(
  'integer setting %s',
  (name, { min, max, default: fallback }) => {
    const setting = name as keyof typeof INTEGER_SETTINGS;

    it.each([min, max])('accepts and uses %p unchanged', (value) => {
      expect(() => validate({ [name]: String(value) })).not.toThrow();
      process.env[name] = String(value);
      expect(readIntSetting(setting)).toBe(value);
    });

    it('rejects the values just outside its bounds', () => {
      expect(() => validate({ [name]: String(max + 1) })).toThrow(
        new RegExp(`${name} must not be greater than ${max}`),
      );
      expect(() => validate({ [name]: String(min - 1) })).toThrow(
        new RegExp(name),
      );
    });

    it.each([undefined, ''])('uses the default for %p', (value) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
      expect(readIntSetting(setting)).toBe(fallback);
    });
  },
);

describe('decimal setting AGENT_TEMPERATURE', () => {
  it.each(['0', '0.7', '.5', '2'])('accepts and uses %p unchanged', (raw) => {
    expect(() => validate({ AGENT_TEMPERATURE: raw })).not.toThrow();
    process.env.AGENT_TEMPERATURE = raw;
    expect(readDecimalSetting('AGENT_TEMPERATURE')).toBe(Number(raw));
  });
});

describe('config namespaces', () => {
  it('read every integer setting through the shared bounds', () => {
    for (const [name, { max }] of Object.entries(INTEGER_SETTINGS)) {
      process.env[name] = String(max);
    }
    process.env.AGENT_TEMPERATURE = '2';

    expect(appConfig().port).toBe(65_535);
    expect(redisConfig().port).toBe(65_535);
    expect(securityConfig()).toMatchObject({
      throttleTtlSeconds: 86_400,
      throttleLimit: 1_000_000,
    });
    expect(cleanupConfig().retentionDays).toBe(36_500);
    expect(scanConfig()).toMatchObject({
      crawlConcurrency: 16,
      scanConcurrency: 8,
      pageTimeoutMs: 1_800_000,
    });
    expect(agentConfig()).toMatchObject({
      concurrency: 16,
      maxUnitsPerPage: 500,
      maxUnitsPerScan: 10_000,
      maxTokensPerRequest: 100_000,
      requestTimeoutMs: 600_000,
      maxImageBytes: 20_000_000,
      temperature: 2,
    });
  });

  it('keep the two-minute page timeout by default', () => {
    delete process.env.SCAN_PAGE_TIMEOUT_MS;
    expect(scanConfig().pageTimeoutMs).toBe(120_000);
  });

  it('read AGENT_MAX_IMAGE_BYTES=1500000 as 1500000', () => {
    process.env.AGENT_MAX_IMAGE_BYTES = '1500000';
    expect(agentConfig().maxImageBytes).toBe(1_500_000);
  });
});
