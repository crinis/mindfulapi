/**
 * Standalone script that bootstraps NestJS (without starting the HTTP server)
 * and writes the current OpenAPI specification to openapi.json.
 *
 * Mirrors the versioning and document builder main.ts uses so the committed
 * spec matches the running API.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/generate-openapi.ts
 */
import 'reflect-metadata';
import { VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { AppModule } from '../src/app.module';
import { createOpenApiDocument } from '../src/config/openapi.config';

async function generate() {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  const document = createOpenApiDocument(app);

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
