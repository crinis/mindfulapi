const mockLaunch = jest.fn();
const mockConnect = jest.fn();

jest.mock('playwright', () => ({
  chromium: {
    launch: (...args: unknown[]) => mockLaunch(...args),
    connect: (...args: unknown[]) => mockConnect(...args),
  },
}));

import { EventEmitter } from 'node:events';
import { BrowserService } from './browser.service';
import { scanConfig } from '../config/configuration';

/** Minimal Playwright Browser: connection state plus the `disconnected` event. */
class FakeBrowser extends EventEmitter {
  private connected = true;
  readonly close = jest.fn(() => {
    this.disconnect();
    return Promise.resolve();
  });

  isConnected(): boolean {
    return this.connected;
  }

  /** Simulates a crash or a lost remote connection. */
  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.emit('disconnected', this);
  }
}

describe('BrowserService', () => {
  const makeService = (playwrightWsUrl: string | null = null) =>
    new BrowserService({ ...scanConfig(), playwrightWsUrl });

  beforeEach(() => {
    mockLaunch.mockReset();
    mockConnect.mockReset();
  });

  it('launches once and shares the browser between callers', async () => {
    const browser = new FakeBrowser();
    mockLaunch.mockResolvedValue(browser);
    const service = makeService();

    const [first, second] = await Promise.all([
      service.getBrowser(),
      service.getBrowser(),
    ]);
    const third = await service.getBrowser();

    expect(mockLaunch).toHaveBeenCalledTimes(1);
    expect(first).toBe(browser);
    expect(second).toBe(browser);
    expect(third).toBe(browser);
    expect(service.isConnected()).toBe(true);
  });

  it('leaves shutdown signals to the application', async () => {
    // Playwright's own handlers would close the browser on SIGTERM while the
    // scan worker is still draining its active scan.
    mockLaunch.mockResolvedValue(new FakeBrowser());

    await makeService().getBrowser();

    expect(mockLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        handleSIGTERM: false,
        handleSIGINT: false,
        handleSIGHUP: false,
      }),
    );
  });

  it('launches a new browser after the previous one disconnected', async () => {
    const crashed = new FakeBrowser();
    const replacement = new FakeBrowser();
    mockLaunch
      .mockResolvedValueOnce(crashed)
      .mockResolvedValueOnce(replacement);
    const service = makeService();

    await service.getBrowser();
    crashed.disconnect();

    expect(service.isConnected()).toBe(false);
    await expect(service.getBrowser()).resolves.toBe(replacement);
    expect(mockLaunch).toHaveBeenCalledTimes(2);
    expect(service.isConnected()).toBe(true);
  });

  it('does not hand out a browser that reports itself disconnected', async () => {
    const stale = new FakeBrowser();
    const replacement = new FakeBrowser();
    mockLaunch.mockResolvedValueOnce(stale).mockResolvedValueOnce(replacement);
    const service = makeService();

    await service.getBrowser();
    // Connection lost without the event having reached the service yet.
    jest.spyOn(stale, 'isConnected').mockReturnValue(false);

    await expect(service.getBrowser()).resolves.toBe(replacement);
  });

  it('retries the launch after a failed first attempt', async () => {
    const browser = new FakeBrowser();
    mockLaunch
      .mockRejectedValueOnce(new Error('spawn failed'))
      .mockResolvedValueOnce(browser);
    const service = makeService();

    await expect(service.getBrowser()).rejects.toThrow(
      'Unable to launch local Chromium: spawn failed',
    );
    await expect(service.getBrowser()).resolves.toBe(browser);
    expect(mockLaunch).toHaveBeenCalledTimes(2);
  });

  it('reconnects to the external Playwright server after it went away', async () => {
    const first = new FakeBrowser();
    const second = new FakeBrowser();
    mockConnect
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(second);
    const service = makeService('ws://playwright:3000');

    await service.getBrowser();
    first.disconnect();

    await expect(service.getBrowser()).rejects.toThrow(
      'Unable to connect to external Playwright: ECONNREFUSED',
    );
    await expect(service.getBrowser()).resolves.toBe(second);
    expect(mockConnect).toHaveBeenCalledTimes(3);
    expect(mockConnect).toHaveBeenCalledWith('ws://playwright:3000');
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it('keeps the secret path of the Playwright server out of logs and errors', async () => {
    const secret = '0123456789abcdef0123456789abcdef';
    const wsUrl = `ws://playwright:3000/${secret}`;
    mockConnect
      .mockRejectedValueOnce(
        new Error(
          `browserType.connect: WebSocket error: connect ECONNREFUSED 172.18.0.3:3000\nCall log:\n  - <ws connecting> ${wsUrl}\n  - <ws error> ${wsUrl} error connect ECONNREFUSED 172.18.0.3:3000\n`,
        ),
      )
      .mockResolvedValueOnce(new FakeBrowser());
    const service = makeService(wsUrl);
    const logger = (service as any).logger;
    const logged: unknown[] = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest
        .spyOn(logger, level)
        .mockImplementation((...args: unknown[]) => logged.push(...args));
    }

    const failure = await service.getBrowser().catch((error: Error) => error);
    await service.getBrowser();

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      'Unable to connect to external Playwright: browserType.connect: WebSocket error: connect ECONNREFUSED',
    );
    expect((failure as Error).message).not.toContain(secret);
    expect((failure as Error).message).toContain(
      'ws://playwright:3000/<redacted>',
    );
    expect(logged.length).toBeGreaterThan(0);
    for (const entry of logged) {
      expect(String(entry)).not.toContain(secret);
    }
    expect(logged.map(String)).toContain(
      'Connecting to external Playwright via WebSocket: ws://playwright:3000/<redacted>',
    );
    // The real URL is still what the browser connects to.
    expect(mockConnect).toHaveBeenCalledWith(wsUrl);
  });

  it('closes the browser on shutdown without treating it as a crash', async () => {
    const browser = new FakeBrowser();
    mockLaunch.mockResolvedValue(browser);
    const service = makeService();
    const warn = jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);

    await service.getBrowser();
    await service.onApplicationShutdown('SIGTERM');

    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(service.isConnected()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
