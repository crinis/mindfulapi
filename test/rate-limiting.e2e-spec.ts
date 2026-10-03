import { INestApplication, Module, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
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

async function createApp(): Promise<INestApplication<App>> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideModule(QueueModule)
    .useModule(MockQueueModule)
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();
  return app;
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
    // The client is limited as a whole, the right token included.
    await request(app.getHttpServer())
      .get('/v1/rules')
      .set('Authorization', 'Bearer testtoken')
      .expect(429);
  });

  it('keeps /health out of the limit', () =>
    request(app.getHttpServer()).get('/health').expect(200));
});
