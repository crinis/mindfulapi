import { INestApplication, ValidationPipe, Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { QueueModule } from '../src/modules/queue.module';
import { ScanQueueService } from '../src/services/scan-queue.service';
import { Scan } from '../src/entities/scan.entity';
import { Issue } from '../src/entities/issue.entity';
import { ScanStatus } from '../src/enums/scan-status.enum';
import { IssueImpact } from '../src/enums/issue-impact.enum';

// ---------------------------------------------------------------------------
// Mock QueueModule — replaces BullMQ so no Redis connection is needed
// ---------------------------------------------------------------------------
const mockAddScanJob = jest.fn().mockResolvedValue(undefined);

@Module({
  imports: [TypeOrmModule.forFeature([Scan, Issue])],
  providers: [
    { provide: ScanQueueService, useValue: { addScanJob: mockAddScanJob } },
  ],
  exports: [ScanQueueService],
})
class MockQueueModule {}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
function authHeader(token = 'testtoken') {
  return { Authorization: `Bearer ${token}` };
}

async function seedCompletedScan(
  dataSource: DataSource,
  url = 'https://seeded.example.com',
): Promise<Scan> {
  const scanRepo = dataSource.getRepository(Scan);
  const issueRepo = dataSource.getRepository(Issue);

  const scan = await scanRepo.save({ url, status: ScanStatus.COMPLETED });

  await issueRepo.save([
    {
      scan: { id: scan.id },
      ruleId: 'color-contrast',
      description: 'Elements must have sufficient color contrast',
      impact: IssueImpact.SERIOUS,
      selector: '.btn',
      context: '<button class="btn">Submit</button>',
      helpUrl:
        'https://dequeuniversity.com/rules/axe/4.11/color-contrast?application=playwright',
    },
    {
      scan: { id: scan.id },
      ruleId: 'color-contrast',
      description: 'Elements must have sufficient color contrast',
      impact: IssueImpact.SERIOUS,
      selector: '.link',
      context: '<a class="link" href="#">Read more</a>',
      helpUrl:
        'https://dequeuniversity.com/rules/axe/4.11/color-contrast?application=playwright',
    },
    {
      scan: { id: scan.id },
      ruleId: 'image-alt',
      description: 'Images must have alternative text',
      impact: IssueImpact.CRITICAL,
      selector: 'img',
      context: '<img src="logo.png">',
      helpUrl:
        'https://dequeuniversity.com/rules/axe/4.11/image-alt?application=playwright',
    },
  ] as any[]);

  return scan as Scan;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('MindfulAPI (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let seededScan: Scan;

  beforeAll(async () => {
    process.env.DATABASE_PATH = ':memory:';
    process.env.AUTH_TOKEN = 'testtoken';
    delete process.env.NODE_ENV;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideModule(QueueModule)
      .useModule(MockQueueModule)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );

    const swaggerConfig = new DocumentBuilder()
      .setTitle('MindfulAPI')
      .setDescription('Test')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api', app, document, { jsonDocumentUrl: 'api-json' });

    await app.init();

    dataSource = moduleFixture.get<DataSource>(DataSource);
    seededScan = await seedCompletedScan(dataSource);
  });

  afterAll(async () => {
    await app.close();
    delete process.env.AUTH_TOKEN;
    delete process.env.DATABASE_PATH;
  });

  beforeEach(() => mockAddScanJob.mockClear());

  // =========================================================================
  // Authentication
  // =========================================================================
  describe('Authentication', () => {
    it('returns 401 when AUTH_TOKEN is set and no header is provided', () =>
      request(app.getHttpServer()).get('/scans').expect(401));

    it('returns 401 for an incorrect Bearer token', () =>
      request(app.getHttpServer())
        .get('/scans')
        .set('Authorization', 'Bearer wrong')
        .expect(401));

    it('returns 401 for a non-Bearer scheme', () =>
      request(app.getHttpServer())
        .get('/scans')
        .set('Authorization', 'Basic testtoken')
        .expect(401));

    it('returns 200 for the correct Bearer token', () =>
      request(app.getHttpServer()).get('/scans').set(authHeader()).expect(200));
  });

  // =========================================================================
  // POST /scans
  // =========================================================================
  describe('POST /scans', () => {
    it('returns 201 with a pending scan', async () => {
      const { body } = await request(app.getHttpServer())
        .post('/scans')
        .set(authHeader())
        .send({ url: 'https://example.com' })
        .expect(201);

      expect(body.id).toEqual(expect.any(Number));
      expect(body.url).toBe('https://example.com');
      expect(body.status).toBe(ScanStatus.PENDING);
      expect(body.violations).toEqual([]);
      expect(body.totalIssueCount).toBe(0);
      expect(body.createdAt).toBeDefined();
      expect(body.updatedAt).toBeDefined();
    });

    it('queues a scan job after creating', async () => {
      await request(app.getHttpServer())
        .post('/scans')
        .set(authHeader())
        .send({ url: 'https://example.com' })
        .expect(201);

      expect(mockAddScanJob).toHaveBeenCalledWith(
        expect.any(Number),
        'https://example.com',
        undefined,
        undefined,
      );
    });

    it('passes rootElement and ruleIds to the queue job', async () => {
      await request(app.getHttpServer())
        .post('/scans')
        .set(authHeader())
        .send({
          url: 'https://example.com',
          rootElement: 'main',
          ruleIds: ['color-contrast'],
        })
        .expect(201);

      expect(mockAddScanJob).toHaveBeenCalledWith(
        expect.any(Number),
        'https://example.com',
        'main',
        ['color-contrast'],
      );
    });

    it('response does not contain removed fields (language, scannerType)', async () => {
      const { body } = await request(app.getHttpServer())
        .post('/scans')
        .set(authHeader())
        .send({ url: 'https://example.com' })
        .expect(201);

      expect(body).not.toHaveProperty('language');
      expect(body).not.toHaveProperty('scannerType');
    });

    it('accepts localhost URLs without a TLD', async () => {
      const { body } = await request(app.getHttpServer())
        .post('/scans')
        .set(authHeader())
        .send({ url: 'http://localhost:8080' })
        .expect(201);

      expect(body.url).toBe('http://localhost:8080');
    });

    it('returns 400 when url is missing', () =>
      request(app.getHttpServer())
        .post('/scans')
        .set(authHeader())
        .send({})
        .expect(400));

    it('returns 400 for a URL without a protocol', () =>
      request(app.getHttpServer())
        .post('/scans')
        .set(authHeader())
        .send({ url: 'example.com' })
        .expect(400));

    it('returns 400 for a plain string that is not a URL', () =>
      request(app.getHttpServer())
        .post('/scans')
        .set(authHeader())
        .send({ url: 'not-a-url' })
        .expect(400));

    it('returns 400 when unknown fields are provided (whitelist validation)', () =>
      request(app.getHttpServer())
        .post('/scans')
        .set(authHeader())
        .send({ url: 'https://example.com', language: 'en' })
        .expect(400));

    it('returns 400 when removed field scannerType is provided', () =>
      request(app.getHttpServer())
        .post('/scans')
        .set(authHeader())
        .send({ url: 'https://example.com', scannerType: 'axe' })
        .expect(400));

    it('returns 401 without authentication', () =>
      request(app.getHttpServer())
        .post('/scans')
        .send({ url: 'https://example.com' })
        .expect(401));
  });

  // =========================================================================
  // GET /scans
  // =========================================================================
  describe('GET /scans', () => {
    it('returns 200 with an array', () =>
      request(app.getHttpServer())
        .get('/scans')
        .set(authHeader())
        .expect(200)
        .expect((res) => expect(Array.isArray(res.body)).toBe(true)));

    it('each scan has the correct shape', async () => {
      const { body } = await request(app.getHttpServer())
        .get('/scans')
        .set(authHeader())
        .expect(200);

      expect(body.length).toBeGreaterThan(0);
      for (const scan of body) {
        expect(scan).toHaveProperty('id');
        expect(scan).toHaveProperty('url');
        expect(scan).toHaveProperty('status');
        expect(scan).toHaveProperty('violations');
        expect(scan).toHaveProperty('totalIssueCount');
        expect(scan).toHaveProperty('createdAt');
        expect(scan).toHaveProperty('updatedAt');
        expect(scan).not.toHaveProperty('language');
        expect(scan).not.toHaveProperty('scannerType');
      }
    });

    it('returns 401 without authentication', () =>
      request(app.getHttpServer()).get('/scans').expect(401));
  });

  // =========================================================================
  // GET /scans/:id
  // =========================================================================
  describe('GET /scans/:id', () => {
    it('returns 200 with the scan', async () => {
      const { body } = await request(app.getHttpServer())
        .get(`/scans/${seededScan.id}`)
        .set(authHeader())
        .expect(200);

      expect(body.id).toBe(seededScan.id);
      expect(body.url).toBe('https://seeded.example.com');
      expect(body.status).toBe(ScanStatus.COMPLETED);
    });

    it('groups issues from the same rule into one violation', async () => {
      const { body } = await request(app.getHttpServer())
        .get(`/scans/${seededScan.id}`)
        .set(authHeader())
        .expect(200);

      // Seeded: 2 color-contrast + 1 image-alt = 2 violations
      expect(body.violations).toHaveLength(2);
      expect(body.totalIssueCount).toBe(3);

      const cc = body.violations.find(
        (v: any) => v.rule.id === 'color-contrast',
      );
      expect(cc.issues).toHaveLength(2);
      expect(cc.impact).toBe(IssueImpact.SERIOUS);

      const ia = body.violations.find((v: any) => v.rule.id === 'image-alt');
      expect(ia.issues).toHaveLength(1);
      expect(ia.impact).toBe(IssueImpact.CRITICAL);
    });

    it('each violation has rule.id, rule.description, rule.helpUrl, impact, and issues', async () => {
      const { body } = await request(app.getHttpServer())
        .get(`/scans/${seededScan.id}`)
        .set(authHeader())
        .expect(200);

      for (const violation of body.violations) {
        expect(violation.rule).toHaveProperty('id');
        expect(violation.rule).toHaveProperty('description');
        expect(violation.rule).toHaveProperty('helpUrl');
        expect(violation.rule.helpUrl).toContain('dequeuniversity.com');
        expect(Object.values(IssueImpact)).toContain(violation.impact);
        expect(Array.isArray(violation.issues)).toBe(true);
        expect(violation).not.toHaveProperty('issueCount');
      }
    });

    it('impact is at the violation level, not inside rule', async () => {
      const { body } = await request(app.getHttpServer())
        .get(`/scans/${seededScan.id}`)
        .set(authHeader())
        .expect(200);

      for (const violation of body.violations) {
        expect(violation).toHaveProperty('impact');
        expect(violation.rule).not.toHaveProperty('impact');
      }
    });

    it('rule does not have removed fields (urls)', async () => {
      const { body } = await request(app.getHttpServer())
        .get(`/scans/${seededScan.id}`)
        .set(authHeader())
        .expect(200);

      for (const violation of body.violations) {
        expect(violation.rule).not.toHaveProperty('urls');
      }
    });

    it('each issue has id and optional selector/context', async () => {
      const { body } = await request(app.getHttpServer())
        .get(`/scans/${seededScan.id}`)
        .set(authHeader())
        .expect(200);

      for (const violation of body.violations) {
        for (const issue of violation.issues) {
          expect(typeof issue.id).toBe('number');
        }
      }
    });

    it('returns 404 for a non-existent scan ID', () =>
      request(app.getHttpServer())
        .get('/scans/999999')
        .set(authHeader())
        .expect(404));

    it('returns 400 for a non-numeric ID', () =>
      request(app.getHttpServer())
        .get('/scans/abc')
        .set(authHeader())
        .expect(400));

    it('returns 401 without authentication', () =>
      request(app.getHttpServer()).get(`/scans/${seededScan.id}`).expect(401));
  });

  // =========================================================================
  // GET /scans (with url filter)
  // =========================================================================
  describe('GET /scans?url=', () => {
    it('returns scans matching the given URL', async () => {
      const { body } = await request(app.getHttpServer())
        .get('/scans?url=https://seeded.example.com')
        .set(authHeader())
        .expect(200);

      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
      for (const scan of body) {
        expect(scan.url).toBe('https://seeded.example.com');
      }
    });

    it('returns an empty array for a URL with no scans', async () => {
      const { body } = await request(app.getHttpServer())
        .get('/scans?url=https://no-match.example.com')
        .set(authHeader())
        .expect(200);

      expect(body).toEqual([]);
    });

    it('returns all scans when url query param is omitted', async () => {
      const { body } = await request(app.getHttpServer())
        .get('/scans')
        .set(authHeader())
        .expect(200);

      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);
    });

    it('returns 401 without authentication', () =>
      request(app.getHttpServer())
        .get('/scans?url=https://example.com')
        .expect(401));
  });

  // =========================================================================
  // GET /rules
  // =========================================================================
  describe('GET /rules', () => {
    it('returns 200 with more than 100 rules', async () => {
      const { body } = await request(app.getHttpServer())
        .get('/rules')
        .set(authHeader())
        .expect(200);

      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(100);
    });

    it('each rule has id, description, helpUrl, tags', async () => {
      const { body } = await request(app.getHttpServer())
        .get('/rules')
        .set(authHeader())
        .expect(200);

      for (const rule of body) {
        expect(typeof rule.id).toBe('string');
        expect(typeof rule.description).toBe('string');
        expect(Array.isArray(rule.tags)).toBe(true);
        if (rule.helpUrl !== undefined) {
          expect(typeof rule.helpUrl).toBe('string');
          expect(rule.helpUrl).toContain('dequeuniversity.com');
        }
      }
    });

    it('does not include removed fields (impact, urls)', async () => {
      const { body } = await request(app.getHttpServer())
        .get('/rules')
        .set(authHeader())
        .expect(200);

      for (const rule of body) {
        expect(rule).not.toHaveProperty('impact');
        expect(rule).not.toHaveProperty('urls');
      }
    });

    it('returns rules sorted alphabetically by ID', async () => {
      const { body } = await request(app.getHttpServer())
        .get('/rules')
        .set(authHeader())
        .expect(200);

      const ids: string[] = body.map((r: any) => r.id);
      expect(ids).toEqual([...ids].sort());
    });

    it('contains well-known axe rules', async () => {
      const { body } = await request(app.getHttpServer())
        .get('/rules')
        .set(authHeader())
        .expect(200);

      const ids: string[] = body.map((r: any) => r.id);
      expect(ids).toContain('color-contrast');
      expect(ids).toContain('image-alt');
      expect(ids).toContain('landmark-one-main');
    });

    it('returns 401 without authentication', () =>
      request(app.getHttpServer()).get('/rules').expect(401));
  });

  // =========================================================================
  // POST /cleanup
  // =========================================================================
  describe('POST /cleanup', () => {
    it('returns 200 with a success message', async () => {
      const { body } = await request(app.getHttpServer())
        .post('/cleanup')
        .set(authHeader())
        .expect(200);

      expect(body.message).toBe('Cleanup completed successfully');
    });

    it('returns 401 without authentication', () =>
      request(app.getHttpServer()).post('/cleanup').expect(401));
  });

  // =========================================================================
  // GET /cleanup/config
  // =========================================================================
  describe('GET /cleanup/config', () => {
    it('returns 200 with enabled, retentionDays and interval', async () => {
      const { body } = await request(app.getHttpServer())
        .get('/cleanup/config')
        .set(authHeader())
        .expect(200);

      expect(typeof body.enabled).toBe('boolean');
      expect(typeof body.retentionDays).toBe('number');
      expect(typeof body.interval).toBe('string');
    });

    it('does not expose removed fields (screenshotDir, batchSize, concurrencyLimit)', async () => {
      const { body } = await request(app.getHttpServer())
        .get('/cleanup/config')
        .set(authHeader())
        .expect(200);

      expect(body).not.toHaveProperty('screenshotDir');
      expect(body).not.toHaveProperty('batchSize');
      expect(body).not.toHaveProperty('concurrencyLimit');
    });

    it('returns 401 without authentication', () =>
      request(app.getHttpServer()).get('/cleanup/config').expect(401));
  });

  // =========================================================================
  // GET /api-json  (OpenAPI spec)
  // =========================================================================
  describe('GET /api-json', () => {
    it('exposes the OpenAPI JSON document', async () => {
      const { body } = await request(app.getHttpServer())
        .get('/api-json')
        .expect(200);

      expect(body.openapi).toMatch(/^3\./);
      expect(body.info.title).toBe('MindfulAPI');
    });

    it('documents all expected paths', async () => {
      const { body } = await request(app.getHttpServer())
        .get('/api-json')
        .expect(200);

      const paths = Object.keys(body.paths);
      expect(paths).toContain('/scans');
      expect(paths).toContain('/scans/{id}');
      expect(paths).toContain('/rules');
      expect(paths).toContain('/cleanup');
      expect(paths).toContain('/cleanup/config');
    });
  });
});
