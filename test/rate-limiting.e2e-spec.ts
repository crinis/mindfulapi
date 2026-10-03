import { INestApplication, Module, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { applyTrustProxy, TrustProxySetting } from '../src/config/trust-proxy';
import { Issue } from '../src/entities/issue.entity';
import { Scan } from '../src/entities/scan.entity';
import { QueueModule } from '../src/modules/queue.module';
import { BasicAuthCryptoService } from '../src/services/basic-auth-crypto.service';
import { BrowserService } from '../src/services/browser.service';
import { ScanQueueService } from '../src/services/scan-queue.service';
import { UrlPolicyService } from '../src/services/url-policy.service';

/** Stands in for the BullMQ/browser infrastructure; no Redis or browser needed. */
@Module({
  imports: [TypeOrmModule.forFeature([Scan, Issue])],
  providers: [
    {
      provide: ScanQueueService,
      useValue: {
        addScanJob: jest.fn(),
        cancelScanJob: jest.fn(),
        getScanJobState: jest.fn().mockResolvedValue(null),
        getQueueStatus: jest.fn().mockResolvedValue({
          waiting: 0,
          active: 0,
          completed: 0,
          failed: 0,
        }),
      },
    },
    {
      provide: BrowserService,
      useValue: { isConnected: jest.fn().mockReturnValue(false) },
    },
    BasicAuthCryptoService,
    { provide: UrlPolicyService, useValue: {} },
  ],
  exports: [
    ScanQueueService,
    BrowserService,
    BasicAuthCryptoService,
    UrlPolicyService,
  ],
})
class MockQueueModule {}

const LIMIT = 3;
const ENV = {
  DATABASE_PATH: ':memory:',
  AUTH_TOKEN: 'testtoken',
  THROTTLE_LIMIT: String(LIMIT),
  THROTTLE_TTL: '60',
};

/** Builds the app with TRUST_PROXY applied the way main.ts applies it. */
async function createApp(): Promise<INestApplication<App>> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideModule(QueueModule)
    .useModule(MockQueueModule)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  applyTrustProxy(
    app,
    app.get(ConfigService).get<TrustProxySetting | null>('app.trustProxy') ??
      null,
  );
  await app.init();
  return app;
}

/** Sends LIMIT + 1 wrong-token requests as one client behind the proxy. */
async function exhaustLimit(app: INestApplication<App>, client: string) {
  for (let attempt = 1; attempt <= LIMIT; attempt++) {
    await request(app.getHttpServer())
      .get('/v1/rules')
      .set('X-Forwarded-For', client)
      .expect(401);
  }
  await request(app.getHttpServer())
    .get('/v1/rules')
    .set('X-Forwarded-For', client)
    .expect(429);
}

describe('Rate limiting (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
    for (const name of Object.keys(ENV)) delete process.env[name];
  });

  it('limits requests with a wrong token, so tokens cannot be guessed without limit', async () => {
    for (let attempt = 1; attempt <= LIMIT; attempt++) {
      await request(app.getHttpServer())
        .get('/v1/rules')
        .set('Authorization', `Bearer wrong-${attempt}`)
        .expect(401);
    }

    await request(app.getHttpServer())
      .get('/v1/rules')
      .set('Authorization', 'Bearer wrong-again')
      .expect(429);
    // The client is limited on this endpoint, the right token included.
    await request(app.getHttpServer())
      .get('/v1/rules')
      .set('Authorization', 'Bearer testtoken')
      .expect(429);
  });

  it('counts per client address and endpoint, for the API routes only', async () => {
    // GET /v1/rules is exhausted by the test above; other endpoints keep
    // their own budget, and paths without a route are not counted at all.
    await request(app.getHttpServer())
      .get('/v1/scans')
      .set('Authorization', 'Bearer wrong')
      .expect(401);
    for (let attempt = 0; attempt <= LIMIT; attempt++) {
      await request(app.getHttpServer()).get('/v1/no-such-route').expect(404);
    }
  });

  it('keeps /health out of the limit', () =>
    request(app.getHttpServer()).get('/health').expect(200));
});

describe('Rate limiting behind a reverse proxy (e2e)', () => {
  let app: INestApplication<App>;

  afterEach(async () => {
    await app.close();
    for (const name of [...Object.keys(ENV), 'TRUST_PROXY']) {
      delete process.env[name];
    }
  });

  it('counts every client behind the proxy as one without TRUST_PROXY', async () => {
    Object.assign(process.env, ENV);
    app = await createApp();

    await exhaustLimit(app, '203.0.113.10');
    await request(app.getHttpServer())
      .get('/v1/rules')
      .set('X-Forwarded-For', '203.0.113.20')
      .expect(429);
  });

  it('limits each client on its own with TRUST_PROXY=1', async () => {
    Object.assign(process.env, ENV, { TRUST_PROXY: '1' });
    app = await createApp();

    await exhaustLimit(app, '203.0.113.10');
    await request(app.getHttpServer())
      .get('/v1/rules')
      .set('X-Forwarded-For', '203.0.113.20')
      .expect(401);
  });

  it('trusts no address the setting does not name', async () => {
    // supertest connects from loopback; a list without it trusts nothing.
    Object.assign(process.env, ENV, { TRUST_PROXY: '10.0.0.0/8' });
    app = await createApp();

    await exhaustLimit(app, '203.0.113.10');
    await request(app.getHttpServer())
      .get('/v1/rules')
      .set('X-Forwarded-For', '203.0.113.20')
      .expect(429);
  });
});
