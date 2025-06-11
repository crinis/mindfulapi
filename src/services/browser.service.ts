import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Browser, chromium } from 'playwright';

/**
 * Singleton browser instance manager for efficient Chromium automation.
 * 
 * This service provides a shared Chromium browser instance across the application
 * to optimize resource usage and improve performance. Rather than launching new
 * browsers for each scan, it maintains a single instance that can be reused for
 * multiple concurrent operations through context isolation.
 * 
 * Key features:
 * - Singleton pattern ensures single browser instance per application
 * - Lazy initialization - browser launches only when first needed
 * - Optimized Chromium flags for headless server environments
 * - Graceful shutdown handling to prevent resource leaks
 * - Docker and containerized environment compatibility
 * 
 * The browser is configured with security and performance flags suitable for
 * server environments, including sandbox disabling for containerized deployments
 * and memory usage optimizations for resource-constrained environments.
 * 
 * @implements {OnApplicationShutdown} Ensures proper cleanup on app termination
 */
@Injectable()
export class BrowserService implements OnApplicationShutdown {
  private readonly logger = new Logger(BrowserService.name);
  private browser: Browser | null = null;

  /**
   * Retrieves the shared browser instance, launching it if not already available.
   * 
   * This method implements lazy initialization of the Chromium browser, creating
   * the instance only when first requested. Subsequent calls return the existing
   * browser for efficient resource usage across multiple scans.
   * 
   * Browser configuration includes:
   * - Headless mode for server environments
   * - Security flags for containerized deployments (--no-sandbox)
   * - Memory optimization flags (--disable-dev-shm-usage)
   * - GPU and acceleration disabling for server compatibility
   * - Process model optimizations (--no-zygote)
   * 
   * @returns Promise resolving to the shared Chromium browser instance
   * @throws {Error} When browser launch fails due to system constraints or configuration issues
   */
  async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.logger.log('Launching Chrome browser instance');
      this.browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
        ],
      });
      this.logger.log('Chrome browser instance launched successfully');
    }
    return this.browser;
  }

  /**
   * Gracefully closes the browser instance during application shutdown.
   * 
   * This lifecycle hook ensures proper cleanup of browser resources when the
   * application terminates, preventing memory leaks and zombie processes.
   * The method is automatically called by NestJS during shutdown events
   * including SIGTERM, SIGINT, and normal application termination.
   * 
   * Browser closure is essential in containerized environments to prevent
   * resource accumulation and ensure clean container shutdowns.
   * 
   * @param signal - Optional shutdown signal that triggered the cleanup
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    if (this.browser) {
      this.logger.log(
        `Shutting down browser instance due to ${signal || 'application shutdown'}`,
      );
      await this.browser.close();
      this.browser = null;
      this.logger.log('Browser instance closed');
    }
  }
}
