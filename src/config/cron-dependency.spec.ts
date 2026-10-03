import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * env.validation checks CLEANUP_INTERVAL with `cron`'s validateCronExpression,
 * and @nestjs/schedule runs the cleanup job with its own `cron` dependency.
 * Both must be one and the same package, or a value the validator accepts
 * could fail when the scheduler parses it at startup (or the reverse).
 */
describe('cron dependency', () => {
  const fromHere = createRequire(__filename);
  const packageJson = (path: string): Record<string, unknown> =>
    JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const scheduleDir = dirname(
    fromHere.resolve('@nestjs/schedule/package.json'),
  );
  const scheduleCron = (
    packageJson(join(scheduleDir, 'package.json')).dependencies as Record<
      string,
      string
    >
  ).cron;

  it('pins the cron version @nestjs/schedule depends on', () => {
    const own = packageJson(join(__dirname, '..', '..', 'package.json'))
      .dependencies as Record<string, string>;

    expect(own.cron).toBe(scheduleCron);
  });

  it('installs that version once, for the validator and the scheduler', () => {
    const validatorCron = fromHere.resolve('cron/package.json');
    const schedulerCron = createRequire(
      join(scheduleDir, 'package.json'),
    ).resolve('cron/package.json');

    expect(schedulerCron).toBe(validatorCron);
    expect(packageJson(validatorCron).version).toBe(scheduleCron);
  });
});
