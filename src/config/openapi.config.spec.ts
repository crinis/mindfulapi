import { Controller, Get, INestApplication } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createOpenApiDocument } from './openapi.config';

@ApiBearerAuth()
@Controller('protected')
class ProtectedController {
  @Get()
  read(): string {
    return 'ok';
  }
}

@Controller('public')
class PublicController {
  @Get()
  read(): string {
    return 'ok';
  }
}

type Operations = Record<string, Record<string, { security?: unknown[] }>>;

describe('OpenAPI security', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProtectedController, PublicController],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(() => app.close());

  it('requires the bearer token on protected operations, with no anonymous alternative', () => {
    const document = createOpenApiDocument(app);

    expect(document.paths['/protected'].get?.security).toEqual([
      { bearer: [] },
    ]);
    expect(document.security ?? []).not.toContainEqual({});
  });

  it('leaves public operations without a security requirement', () => {
    const document = createOpenApiDocument(app);

    expect(document.paths['/public'].get?.security).toBeUndefined();
    expect(document.security).toBeUndefined();
  });

  it('describes the token as required unless AUTH_DISABLED=true', () => {
    const scheme = createOpenApiDocument(app).components?.securitySchemes
      ?.bearer as { description?: string; bearerFormat?: string };

    expect(scheme.description).toMatch(
      /required.*unless the server runs with AUTH_DISABLED=true/i,
    );
    expect(scheme.description).not.toMatch(/to enable authentication/);
    // The token is an opaque shared secret, not a JWT.
    expect(scheme.bearerFormat).toBeUndefined();
  });

  it('matches the committed openapi.json', () => {
    const committed = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'openapi.json'), 'utf8'),
    ) as { security?: unknown[]; paths: Operations };

    expect(committed.security ?? []).not.toContainEqual({});
    for (const [path, item] of Object.entries(committed.paths)) {
      for (const operation of Object.values(item)) {
        if (path === '/health') {
          expect(operation.security).toBeUndefined();
        } else {
          expect(operation.security).toEqual([{ bearer: [] }]);
        }
      }
    }
  });
});
