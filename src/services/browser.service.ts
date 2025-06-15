import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Browser, chromium } from 'playwright';

/**
 * Singleton browser instance manager for efficient Chromium automation.
 * 
 * This service provides a shared Chromium browser instance across the application
 * to optimize resource usage and improve performance. It supports two modes:
 * 
 * 1. **External CDP Connection**: Connect to an external Chromium instance via 
 *    Chrome DevTools Protocol when CHROMIUM_CDP_URL is configured
 * 2. **Local Browser Launch**: Launch a local headless Chromium instance when 
 *    no external URL is provided
 * 
 * Key features:
 * - Singleton pattern ensures single browser instance per application
 * - Lazy initialization - browser launches/connects only when first needed
 * - Support for external browser services via CDP
 * - Optimized Chromium flags for headless server environments
 * - Graceful shutdown handling to prevent resource leaks
 * - Docker and containerized environment compatibility
 * 
 * Environment Variables:
 * - CHROMIUM_CDP_URL: WebSocket URL to external Chromium CDP endpoint
 *   Example: ws://chromium:9222 or ws://localhost:9222
 * 
 * @implements {OnApplicationShutdown} Ensures proper cleanup on app termination
 */
@Injectable()
export class BrowserService implements OnApplicationShutdown {
  private readonly logger = new Logger(BrowserService.name);
  private browser: Browser | null = null;
  private isExternalConnection = false;

  /**
   * Retrieves the shared browser instance, connecting to external CDP or launching locally.
   * 
   * This method implements lazy initialization of the Chromium browser. It first checks
   * for the CHROMIUM_CDP_URL environment variable:
   * 
   * - If set: Connects to external Chromium instance via Chrome DevTools Protocol
   * - If not set: Launches local headless Chromium with optimized flags
   * 
   * External CDP connection enables using dedicated browser services like:
   * - Docker containers running Chromium
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
   * @returns Promise resolving to the shared Chromium browser instance
   * @throws {Error} When browser launch/connection fails
   */
  async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      const cdpUrl = process.env.CHROMIUM_CDP_URL;
      
      if (cdpUrl) {
        await this.connectToExternalBrowser(cdpUrl);
      } else {
        await this.launchLocalBrowser();
      }
    }
    return this.browser!; // Non-null assertion safe here as browser is set above
  }

  /**
   * Connects to an external Chromium instance via Chrome DevTools Protocol.
   * 
   * This method establishes a WebSocket connection to a remote Chromium instance
   * running with CDP enabled. The external browser should be started with:
   * --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0
   * 
   * @param cdpUrl - WebSocket URL to the CDP endpoint (e.g., ws://chromium:9222)
   * @throws {Error} When connection to external browser fails
   */
  private async connectToExternalBrowser(cdpUrl: string): Promise<void> {
    this.logger.log(`Connecting to external Chromium via CDP: ${cdpUrl}`);
    
    try {
      this.browser = await chromium.connectOverCDP(cdpUrl);
      this.isExternalConnection = true;
      this.logger.log('Successfully connected to external Chromium instance');
    } catch (error) {
      this.logger.error(`Failed to connect to external Chromium at ${cdpUrl}:`, error);
      throw new Error(`Unable to connect to external Chromium: ${error.message}`);
    }
  }

  /**
   * Launches a local headless Chromium instance with optimized flags.
   * 
   * This fallback method creates a local browser instance when no external
   * CDP URL is configured.
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
        this.logger.log('Disconnected from external Chromium instance');
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
