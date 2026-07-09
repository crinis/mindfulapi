import { HealthService } from './health.service';

describe('HealthService', () => {
  const makeService = (overrides: {
    dbOk?: boolean;
    queueOk?: boolean;
    browserConnected?: boolean;
  }) => {
    const dataSource = {
      query:
        overrides.dbOk === false
          ? jest.fn().mockRejectedValue(new Error('db down'))
          : jest.fn().mockResolvedValue([{ 1: 1 }]),
    };
    const queueCounts = { waiting: 1, active: 0, completed: 5, failed: 0 };
    const scanQueue = {
      getQueueStatus:
        overrides.queueOk === false
          ? jest.fn().mockRejectedValue(new Error('redis down'))
          : jest.fn().mockResolvedValue(queueCounts),
    };
    const browser = {
      isConnected: jest
        .fn()
        .mockReturnValue(overrides.browserConnected ?? true),
    };
    return new HealthService(
      dataSource as never,
      scanQueue as never,
      browser as never,
    );
  };

  it('reports ok when database and redis are up', async () => {
    const result = await makeService({}).check();
    expect(result.status).toBe('ok');
    expect(result.checks.database).toBe('up');
    expect(result.checks.redis).toBe('up');
    expect(result.checks.queue).toEqual({
      waiting: 1,
      active: 0,
      completed: 5,
      failed: 0,
    });
  });

  it('reports error and null queue when redis is down', async () => {
    const result = await makeService({ queueOk: false }).check();
    expect(result.status).toBe('error');
    expect(result.checks.redis).toBe('down');
    expect(result.checks.queue).toBeNull();
  });

  it('reports error when the database is down', async () => {
    const result = await makeService({ dbOk: false }).check();
    expect(result.status).toBe('error');
    expect(result.checks.database).toBe('down');
  });

  it('surfaces browser connectivity without affecting overall status', async () => {
    const result = await makeService({ browserConnected: false }).check();
    expect(result.status).toBe('ok');
    expect(result.checks.browserConnected).toBe(false);
  });
});
