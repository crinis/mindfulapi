import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Browser, chromium } from 'playwright';

/**
 * Manages a single shared Playwright browser instance for the whole app.
 *
 * Resolution order:
 * 1. Connect to external browser if `PLAYWRIGHT_WS_URL` is set.
 * 2. Otherwise launch local headless Chromium.
 */
@Injectable()
export class BrowserService implements OnApplicationShutdown {
  private readonly logger = new Logger(BrowserService.name);
  /** Lazily initialized shared browser instance. */
  private browser: Browser | null = null;
  /** In-flight initialization promise — prevents concurrent launches. */
  private initPromise: Promise<Browser> | null = null;
  /** Indicates whether the browser is locally launched or externally connected. */
  private connectionType: 'external' | 'local' | null = null;

  /**
   * Returns the shared browser instance, creating it on first access.
   * Concurrent callers await the same initialization promise.
   */
  async getBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    this.initPromise ??= this.initBrowser();
    return this.initPromise;
  }

  /**
   * Initializes the browser by connecting externally or launching locally.
   */
  private async initBrowser(): Promise<Browser> {
    const playwrightUrl = process.env.PLAYWRIGHT_WS_URL;
    if (playwrightUrl) {
      await this.connectToExternalPlaywright(playwrightUrl);
    } else {
      await this.launchLocalBrowser();
    }
    return this.browser!;
  }

  /**
   * Connects to an externally managed Playwright browser over WebSocket.
   *
   * @param wsUrl External Playwright endpoint URL.
   */
  private async connectToExternalPlaywright(wsUrl: string): Promise<void> {
    this.logger.log(
      `Connecting to external Playwright via WebSocket: ${wsUrl}`,
    );

    try {
      this.browser = await chromium.connect(wsUrl);
      this.connectionType = 'external';
      this.logger.log('Connected to external Playwright instance');
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
  private async launchLocalBrowser(): Promise<void> {
    this.logger.log('Launching local Chromium browser instance');

    try {
      this.browser = await chromium.launch({ headless: true });
      this.connectionType = 'local';
      this.logger.log('Local Chromium browser instance launched successfully');
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
    if (!this.browser) return;

    const mode = this.connectionType || 'unknown';
    this.logger.log(
      `Shutting down ${mode} browser connection due to ${signal || 'application shutdown'}`,
    );

    await this.browser.close();

    if (mode === 'external') {
      this.logger.log('Disconnected from external Playwright instance');
    } else {
      this.logger.log('Local browser instance closed');
    }

    this.browser = null;
    this.initPromise = null;
    this.connectionType = null;
  }
}
