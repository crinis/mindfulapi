import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import * as express from 'express';
import { AppModule } from './app.module';
import { createOpenApiConfig } from './config/openapi.config';

/**
 * Bootstrap the NestJS application.
 *
 * Initializes security middleware, validation, OpenAPI documentation, and HTTP server startup.
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // Explicit body size limits to prevent oversized payloads.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Security headers: X-Content-Type-Options, X-Frame-Options, HSTS, etc.
  app.use(helmet());

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  const document = SwaggerModule.createDocument(app, createOpenApiConfig());
  SwaggerModule.setup('api', app, document, {
    jsonDocumentUrl: 'api-json',
    yamlDocumentUrl: 'api-yaml',
  });

  await app.listen(process.env.PORT ?? 3000);
}

/**
 * Fail fast on bootstrap errors so orchestration environments can restart the service.
 */
bootstrap().catch((error) => {
  console.error('Failed to start application:', error);
  process.exit(1);
});
