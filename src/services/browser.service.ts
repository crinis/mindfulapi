import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Browser, chromium } from 'playwright';

/**
 * Singleton browser instance manager for efficient browser automation.
 * 
 * This service provides a shared browser instance across the application
 * to optimize resource usage and improve performance. It supports two modes:
 * 
 * 1. **External Playwright Connection**: Connect to an external Playwright instance via 
 *    WebSocket when PLAYWRIGHT_WS_URL is configured
 * 2. **Local Browser Launch**: Launch a local headless Chromium instance when 
 *    no external URL is provided
 * 
 * Key features:
 * - Singleton pattern ensures single browser instance per application
 * - Lazy initialization - browser launches/connects only when first needed
 * - Support for external Playwright browser services via WebSocket
 * - Optimized Chromium flags for headless server environments
 * - Graceful shutdown handling to prevent resource leaks
 * - Docker and containerized environment compatibility
 * 
 * Environment Variables:
 * - PLAYWRIGHT_WS_URL: WebSocket URL to external Playwright instance
 *   Example: ws://playwright:3000 or ws://localhost:3000
 * 
 * @implements {OnApplicationShutdown} Ensures proper cleanup on app termination
 */
@Injectable()
export class BrowserService implements OnApplicationShutdown {
  private readonly logger = new Logger(BrowserService.name);
  private browser: Browser | null = null;
  private isExternalConnection = false;

  /**
   * Retrieves the shared browser instance, connecting to external Playwright or launching locally.
   * 
   * This method implements lazy initialization of the browser. It first checks
   * for the PLAYWRIGHT_WS_URL environment variable:
   * 
   * - If set: Connects to external Playwright instance via WebSocket
   * - If not set: Launches local headless Chromium with optimized flags
   * 
   * External Playwright connection enables using dedicated browser services like:
   * - Docker containers running Playwright
   * - Cloud browser services
   * - Separate browser pods in Kubernetes
   * 
   * Local browser configuration includes:
   * - Headless mode for server environments
   * - Security flags for containerized deployments (--no-sandbox)
   * - Memory optimization flags (--disable-dev-shm-usage)
   * - GPU and acceleration disabling for server compatibility
   * - Process model optimizations (--no-zygote)
   * 
   * @returns Promise resolving to the shared browser instance
   * @throws {Error} When browser launch/connection fails
   */
  async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      const playwrightUrl = process.env.PLAYWRIGHT_WS_URL;
      
      if (playwrightUrl) {
        await this.connectToExternalPlaywright(playwrightUrl);
      } else {
        await this.launchLocalBrowser();
      }
    }
    return this.browser!; // Non-null assertion safe here as browser is set above
  }

  /**
   * Connects to an external Playwright instance via WebSocket.
   * 
   * This method establishes a WebSocket connection to a remote Playwright instance.
   * The external Playwright service should be running and accessible via WebSocket.
   * 
   * @param wsUrl - WebSocket URL to the Playwright endpoint (e.g., ws://playwright:3000)
   * @throws {Error} When connection to external Playwright fails
   */
  private async connectToExternalPlaywright(wsUrl: string): Promise<void> {
    this.logger.log(`Connecting to external Playwright via WebSocket: ${wsUrl}`);
    
    try {
      this.browser = await chromium.connect(wsUrl);
      this.isExternalConnection = true;
      this.logger.log('Successfully connected to external Playwright instance');
    } catch (error) {
      this.logger.error(`Failed to connect to external Playwright at ${wsUrl}:`, error);
      throw new Error(`Unable to connect to external Playwright: ${error.message}`);
    }
  }

  /**
   * Launches a local headless Chromium instance with optimized flags.
   * 
   * This fallback method creates a local browser instance when no external
   * Playwright URL is configured.
   * 
   * @throws {Error} When local browser launch fails
   */
  private async launchLocalBrowser(): Promise<void> {
    this.logger.log('Launching local Chrome browser instance');
    
    try {
      this.browser = await chromium.launch({
        headless: true,
      });
      this.isExternalConnection = false;
      this.logger.log('Local Chrome browser instance launched successfully');
    } catch (error) {
      this.logger.error('Failed to launch local Chromium browser:', error);
      throw new Error(`Unable to launch local Chromium: ${error.message}`);
    }
  }

  /**
   * Gracefully closes the browser instance during application shutdown.
   * 
   * This lifecycle hook ensures proper cleanup of browser resources when the
   * application terminates. For external connections, it disconnects gracefully
   * without closing the remote browser. For local instances, it closes the browser
   * completely to prevent memory leaks and zombie processes.
   * 
   * The method is automatically called by NestJS during shutdown events
   * including SIGTERM, SIGINT, and normal application termination.
   * 
   * @param signal - Optional shutdown signal that triggered the cleanup
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    if (this.browser) {
      const connectionType = this.isExternalConnection ? 'external' : 'local';
      this.logger.log(
        `Shutting down ${connectionType} browser connection due to ${signal || 'application shutdown'}`,
      );
      
      if (this.isExternalConnection) {
        // For external connections, disconnect without closing the remote browser
        await this.browser.close();
        this.logger.log('Disconnected from external Playwright instance');
      } else {
        // For local instances, close the browser completely
        await this.browser.close();
        this.logger.log('Local browser instance closed');
      }
      
      this.browser = null;
      this.isExternalConnection = false;
    }
  }
}
