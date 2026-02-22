import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

/**
 * Bootstrap the NestJS application.
 *
 * Initializes security middleware, validation, OpenAPI documentation, and HTTP server startup.
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Security headers: X-Content-Type-Options, X-Frame-Options, HSTS, etc.
  app.use(helmet());

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('MindfulAPI')
    .setDescription(
      'Automated web accessibility scanning API powered by axe-core and Playwright. ' +
        'Built for use with the [mindfula11y](https://github.com/crinis/mindfula11y) TYPO3 extension.',
    )
    .setVersion('1.0')
    .addTag('Scans', 'Create and inspect accessibility scan runs')
    .addTag('Rules', 'List available axe-core rules and metadata')
    .addTag('Cleanup', 'Manage retention cleanup lifecycle')
    .addBearerAuth({
      description:
        'Set the AUTH_TOKEN environment variable to enable authentication. Leave unset for open access.',
      type: 'http',
      scheme: 'bearer',
    })
    .addServer('/', 'Current environment')
    .build();

  const document = SwaggerModule.createDocument(app, config);
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
