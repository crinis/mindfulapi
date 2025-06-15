import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import * as path from 'path';

/**
 * Bootstrap function that initializes and configures the NestJS application.
 *
 * Sets up global validation pipes, static file serving for screenshots,
 * and starts the HTTP server on the configured port.
 *
 * @throws {Error} When application fails to start properly
 */
async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Configure global input validation with transformation and security features
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true, // Automatically transform payloads to DTO instances
      whitelist: true, // Strip properties without decorators
      forbidNonWhitelisted: true, // Throw errors for non-whitelisted properties
    }),
  );

  // Configure static file serving for accessibility issue screenshots
  // Screenshots are served at /screenshots/{filename} endpoint
  const screenshotDir = process.env.SCREENSHOT_DIR || './screenshots';
  
  // Handle both relative and absolute paths correctly
  const resolvedScreenshotDir = path.isAbsolute(screenshotDir) 
    ? screenshotDir 
    : join(process.cwd(), screenshotDir);
    
  app.useStaticAssets(resolvedScreenshotDir, {
    prefix: '/screenshots/',
  });

  await app.listen(process.env.PORT ?? 3000);
}

// Start the application and handle startup errors gracefully
bootstrap().catch((error) => {
  console.error('Failed to start application:', error);
  process.exit(1);
});
