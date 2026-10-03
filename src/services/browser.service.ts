import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Browser, chromium } from 'playwright';
import { scanConfig } from '../config/configuration';

/**
 * Manages a single shared Playwright browser instance for the whole app.
 *
 * Resolution order:
 * 1. Connect to external browser if `PLAYWRIGHT_WS_URL` is set.
 * 2. Otherwise launch local headless Chromium.
 *
 * The browser is created lazily and replaced on demand: once it disconnects
 * (crash, remote Playwright server restart) or a launch/connect attempt fails,
 * the next {@link getBrowser} call starts a fresh one.
 */
@Injectable()
export class BrowserService implements OnApplicationShutdown {
  private readonly logger = new Logger(BrowserService.name);
  /** Lazily initialized shared browser instance; null until connected. */
  private browser: Browser | null = null;
  /** In-flight initialization promise — prevents concurrent launches. */
  private initPromise: Promise<Browser> | null = null;
  /** Indicates whether the browser is locally launched or externally connected. */
  private connectionType: 'external' | 'local' | null = null;

  /**
   * @param config Scan namespace configuration (Playwright endpoint).
   */
  constructor(
    @Inject(scanConfig.KEY)
    private readonly config: ConfigType<typeof scanConfig>,
  ) {}

  /**
   * Reports whether a browser is currently initialized and connected, without
   * triggering a launch. Used by the health endpoint.
   */
  isConnected(): boolean {
    return this.browser?.isConnected() ?? false;
  }

  /**
   * Returns the shared browser instance, creating it on first access and
   * replacing it once it has disconnected. Concurrent callers await the same
   * initialization promise.
   */
  async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.browser) {
      // Disconnected, but the `disconnected` event has not been handled yet.
      this.forget(this.browser);
    }
    this.initPromise ??= this.initBrowser();
    return this.initPromise;
  }

  /**
   * Initializes the browser by connecting externally or launching locally.
   * A failed attempt is not cached, so the next call tries again.
   */
  private async initBrowser(): Promise<Browser> {
    const playwrightUrl = this.config.playwrightWsUrl;
    let browser: Browser;
    try {
      browser = playwrightUrl
        ? await this.connectToExternalPlaywright(playwrightUrl)
        : await this.launchLocalBrowser();
    } catch (error) {
      this.initPromise = null;
      throw error;
    }
    browser.on('disconnected', () => {
      if (this.browser !== browser) return;
      this.logger.warn(
        'Browser disconnected; the next scan starts a new browser connection',
      );
      this.forget(browser);
    });
    this.browser = browser;
    return browser;
  }

  /** Drops a browser that is no longer usable so the next call replaces it. */
  private forget(browser: Browser): void {
    if (this.browser !== browser) return;
    this.browser = null;
    this.initPromise = null;
    this.connectionType = null;
  }

  /**
   * Connects to an externally managed Playwright browser over WebSocket.
   *
   * @param wsUrl External Playwright endpoint URL.
   */
  private async connectToExternalPlaywright(wsUrl: string): Promise<Browser> {
    this.logger.log(
      `Connecting to external Playwright via WebSocket: ${wsUrl}`,
    );

    try {
      const browser = await chromium.connect(wsUrl);
      this.connectionType = 'external';
      this.logger.log('Connected to external Playwright instance');
      return browser;
    } catch (error) {
      this.logger.error(
        `Failed to connect to external Playwright at ${wsUrl}:`,
        error,
      );
      throw new Error(
        `Unable to connect to external Playwright: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Launches a local headless Chromium instance.
   */
  private async launchLocalBrowser(): Promise<Browser> {
    this.logger.log('Launching local Chromium browser instance');

    try {
      const browser = await chromium.launch({ headless: true });
      this.connectionType = 'local';
      this.logger.log('Local Chromium browser instance launched successfully');
      return browser;
    } catch (error) {
      this.logger.error('Failed to launch local Chromium browser:', error);
      throw new Error(
        `Unable to launch local Chromium: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Gracefully closes the shared browser when the Nest application shuts down.
   *
   * @param signal Optional shutdown signal reason.
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    const browser = this.browser;
    if (!browser) return;

    const mode = this.connectionType || 'unknown';
    this.logger.log(
      `Shutting down ${mode} browser connection due to ${signal || 'application shutdown'}`,
    );

    // Forget it first: the `disconnected` event of an intentional close is
    // not a crash.
    this.forget(browser);
    await browser.close();

    if (mode === 'external') {
      this.logger.log('Disconnected from external Playwright instance');
    } else {
      this.logger.log('Local browser instance closed');
    }
  }
}
