/**
 * Standalone script that bootstraps NestJS (without starting the HTTP server)
 * and writes the current OpenAPI specification to openapi.json.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/generate-openapi.ts
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { AppModule } from '../src/app.module';
import { createOpenApiConfig } from '../src/config/openapi.config';

async function generate() {
  const app = await NestFactory.create(AppModule, { logger: false });

  const document = SwaggerModule.createDocument(app, createOpenApiConfig());

  const outPath = resolve(__dirname, '..', 'openapi.json');
  writeFileSync(outPath, JSON.stringify(document, null, 2));
  console.log(`OpenAPI spec written to ${outPath}`);

  await app.close();
  process.exit(0);
}

generate().catch((error) => {
  console.error('Failed to generate OpenAPI spec:', error);
  process.exit(1);
});
