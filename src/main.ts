import { NestFactory, HttpAdapterHost } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule } from '@nestjs/swagger';
import { ValidationError } from 'class-validator';
import helmet from 'helmet';
import * as express from 'express';
import { AppModule } from './app.module';
import {
  createOpenApiConfig,
  patchOpenApiDocument,
} from './config/openapi.config';
import { ProblemDetailsFilter } from './filters/problem-details.filter';
import {
  flattenValidationErrors,
  ValidationProblemException,
} from './exceptions/validation-problem.exception';

/**
 * Bootstrap the NestJS application.
 *
 * Initializes security middleware, validation, OpenAPI documentation, and HTTP server startup.
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // Required so BrowserService and the BullMQ worker shut down cleanly on SIGTERM/SIGINT.
  app.enableShutdownHooks();

  // URI versioning: all routes are served under /v1 by default.
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  // Explicit body size limits to prevent oversized payloads.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Security headers: X-Content-Type-Options, X-Frame-Options, HSTS, etc.
  app.use(helmet());

  const configService = app.get(ConfigService);
  const corsOrigins = configService.get<string[]>('app.corsOrigins') ?? [];
  if (corsOrigins.length > 0) {
    app.enableCors({
      origin: corsOrigins,
      exposedHeaders: ['Location'],
    });
  }

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      // Emit structured field errors so the problem-details filter can render
      // them as the RFC 9457 `errors` extension member.
      exceptionFactory: (errors: ValidationError[]) =>
        new ValidationProblemException(flattenValidationErrors(errors)),
    }),
  );

  app.useGlobalFilters(new ProblemDetailsFilter(app.get(HttpAdapterHost)));

  const document = patchOpenApiDocument(
    SwaggerModule.createDocument(app, createOpenApiConfig()),
  );
  SwaggerModule.setup('api', app, document, {
    jsonDocumentUrl: 'api-json',
    yamlDocumentUrl: 'api-yaml',
  });

  await app.listen(configService.getOrThrow<number>('app.port'));
}

/**
 * Fail fast on bootstrap errors so orchestration environments can restart the service.
 */
bootstrap().catch((error) => {
  console.error('Failed to start application:', error);
  process.exit(1);
});
