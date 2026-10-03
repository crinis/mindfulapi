import { WriteQueue } from './write-queue.service';

describe('WriteQueue', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

  it('runs one write at a time, in the order they were queued', async () => {
    const queue = new WriteQueue();
    const events: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const write = (name: string) =>
      queue.run(async () => {
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        events.push(`${name} start`);
        await tick();
        events.push(`${name} end`);
        inFlight--;
        return name;
      });

    const results = await Promise.all([write('a'), write('b'), write('c')]);

    expect(results).toEqual(['a', 'b', 'c']);
    expect(maxInFlight).toBe(1);
    expect(events).toEqual([
      'a start',
      'a end',
      'b start',
      'b end',
      'c start',
      'c end',
    ]);
  });

  it('rejects only the write that failed and runs the next one', async () => {
    const queue = new WriteQueue();

    const failed = queue.run(() =>
      Promise.reject(new Error('SQLITE_CONSTRAINT')),
    );
    const next = queue.run(() => Promise.resolve('saved'));

    await expect(failed).rejects.toThrow('SQLITE_CONSTRAINT');
    await expect(next).resolves.toBe('saved');
  });

  it('runs a write that throws synchronously as a rejection', async () => {
    const queue = new WriteQueue();

    const failed = queue.run(() => {
      throw new Error('bad entity');
    });

    await expect(failed).rejects.toThrow('bad entity');
    await expect(queue.run(() => Promise.resolve(1))).resolves.toBe(1);
  });
});
