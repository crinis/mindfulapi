import {
  INestApplication,
  ValidationPipe,
  Module,
  VersioningType,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ProblemDetailsFilter } from '../src/filters/problem-details.filter';
import {
  flattenValidationErrors,
  ValidationProblemException,
} from '../src/exceptions/validation-problem.exception';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { QueueModule } from '../src/modules/queue.module';
import { ScanQueueService } from '../src/services/scan-queue.service';
import { BrowserService } from '../src/services/browser.service';
import { BasicAuthCryptoService } from '../src/services/basic-auth-crypto.service';
import { UrlPolicyService } from '../src/services/url-policy.service';
import { Scan } from '../src/entities/scan.entity';
import { Issue } from '../src/entities/issue.entity';
import { ScanStatus } from '../src/enums/scan-status.enum';
import { IssueImpact } from '../src/enums/issue-impact.enum';
import { ScanMode } from '../src/enums/scan-mode.enum';

const mockAddScanJob = jest.fn().mockResolvedValue(undefined);

const mockPage = {
  setContent: jest.fn().mockResolvedValue(undefined),
  pdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 mock')),
  close: jest.fn().mockResolvedValue(undefined),
};

@Module({
  imports: [TypeOrmModule.forFeature([Scan, Issue])],
  providers: [
    {
      provide: ScanQueueService,
      useValue: { addScanJob: mockAddScanJob },
    },
    {
      provide: BrowserService,
      useValue: {
        getBrowser: jest.fn().mockResolvedValue({
          newPage: jest.fn().mockResolvedValue(mockPage),
        }),
      },
    },
    BasicAuthCryptoService,
    {
      provide: UrlPolicyService,
      useValue: {
        assertAllowedTargets: jest.fn().mockResolvedValue(undefined),
      },
    },
  ],
  exports: [
    ScanQueueService,
    BrowserService,
    BasicAuthCryptoService,
    UrlPolicyService,
  ],
})
class MockQueueModule {}

function authHeader(token = 'testtoken') {
  return { Authorization: `Bearer ${token}` };
}

async function seedCompletedScan(
  dataSource: DataSource,
  url = 'https://seeded.example.com',
): Promise<Scan> {
  const scanRepo = dataSource.getRepository(Scan);
  const issueRepo = dataSource.getRepository(Issue);

  const scan = await scanRepo.save({
    url,
    mode: ScanMode.SINGLE_URL,
    targets: [url],
    status: ScanStatus.COMPLETED,
    pagesDiscovered: 1,
    pagesScanned: 1,
    pagesFailed: 0,
  });

  await issueRepo.save([
    {
      scan: { id: scan.id },
      ruleId: 'color-contrast',
      description: 'Elements must have sufficient color contrast',
      impact: IssueImpact.SERIOUS,
      pageUrl: url,
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
      pageUrl: url,
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
      pageUrl: `${url}/about`,
      selector: 'img',
      context: '<img src="logo.png">',
      helpUrl:
        'https://dequeuniversity.com/rules/axe/4.11/image-alt?application=playwright',
    },
  ] as any[]);

  return scan;
}

describe('MindfulAPI (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let seededScan: Scan;

  beforeAll(async () => {
    process.env.DATABASE_PATH = ':memory:';
    process.env.AUTH_TOKEN = 'testtoken';
    // Keep scan creation independent of live DNS in CI.
    process.env.SCAN_ALLOW_PRIVATE_TARGETS = 'true';
    delete process.env.NODE_ENV;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideModule(QueueModule)
      .useModule(MockQueueModule)
      .compile();

    app = moduleFixture.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        exceptionFactory: (errors) =>
          new ValidationProblemException(flattenValidationErrors(errors)),
      }),
    );
    app.useGlobalFilters(new ProblemDetailsFilter(app.get(HttpAdapterHost)));

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
    delete process.env.SCAN_ALLOW_PRIVATE_TARGETS;
  });

  beforeEach(() => mockAddScanJob.mockClear());

  describe('Authentication', () => {
    it('returns 401 when token is missing', () =>
      request(app.getHttpServer()).get('/v1/scans').expect(401));

    it('returns 401 when token is invalid', () =>
      request(app.getHttpServer())
        .get('/v1/scans')
        .set(authHeader('wrong-token'))
        .expect(401));

    it('returns 200 for correct Bearer token', () =>
      request(app.getHttpServer())
        .get('/v1/scans')
        .set(authHeader())
        .expect(200));

    it('protects GET /rules when token is missing', () =>
      request(app.getHttpServer()).get('/v1/rules').expect(401));

    it('protects GET /scans/:id when token is missing', () =>
      request(app.getHttpServer())
        .get(`/v1/scans/${seededScan.id}`)
        .expect(401));

    it('protects POST /cleanup when token is missing', () =>
      request(app.getHttpServer()).post('/v1/cleanup').expect(401));

    it('protects GET /cleanup/config when token is missing', () =>
      request(app.getHttpServer()).get('/v1/cleanup/policy').expect(401));
  });

  describe('Error format (RFC 9457 problem+json)', () => {
    it('returns problem+json for a 401', async () => {
      const { body, headers } = await request(app.getHttpServer())
        .get('/v1/scans')
        .expect(401);

      expect(headers['content-type']).toContain('application/problem+json');
      expect(body.status).toBe(401);
      expect(body.title).toBe('Unauthorized');
      expect(body.instance).toBe('/v1/scans');
    });

    it('returns problem+json for a 404', async () => {
      const { body } = await request(app.getHttpServer())
        .get('/v1/scans/999999')
        .set(authHeader())
        .expect(404);

      expect(body.status).toBe(404);
      expect(body.title).toBe('Not Found');
      expect(typeof body.detail).toBe('string');
    });

    it('returns a validation problem with field errors for a 400', async () => {
      const { body, headers } = await request(app.getHttpServer())
        .post('/v1/scans')
        .set(authHeader())
        .send({ mode: ScanMode.SINGLE_URL, url: 'not-a-url' })
        .expect(400);

      expect(headers['content-type']).toContain('application/problem+json');
      expect(body.status).toBe(400);
      expect(body.title).toBe('Validation Failed');
      expect(Array.isArray(body.errors)).toBe(true);
      expect(body.errors.length).toBeGreaterThan(0);
      expect(body.errors[0]).toHaveProperty('pointer');
      expect(body.errors[0]).toHaveProperty('message');
    });
  });

  describe('POST /scans', () => {
    it('creates a single_url scan run', async () => {
      const { body, headers } = await request(app.getHttpServer())
        .post('/v1/scans')
        .set(authHeader())
        .send({
          mode: ScanMode.SINGLE_URL,
          url: 'https://example.com',
          scanOptions: { rootElement: 'main' },
        })
        .expect(201);

      expect(body.id).toEqual(expect.any(Number));
      expect(body.mode).toBe(ScanMode.SINGLE_URL);
      expect(body.targets).toEqual(['https://example.com/']);
      expect(body.status).toBe(ScanStatus.PENDING);
      expect(body.scanOptions.rootElement).toBe('main');
      expect(body.violations).toEqual([]);
      expect(body.totalIssueCount).toBe(0);
      expect(body.progress.pagesDiscovered).toBe(0);
      expect(headers.location).toBe(`/v1/scans/${body.id}`);
    });

    it('creates a url_list scan run', async () => {
      const { body } = await request(app.getHttpServer())
        .post('/v1/scans')
        .set(authHeader())
        .send({
          mode: ScanMode.URL_LIST,
          urls: ['https://example.com', 'https://example.com/about'],
        })
        .expect(201);

      expect(body.mode).toBe(ScanMode.URL_LIST);
      expect(body.targets).toHaveLength(2);
    });

    it('creates a crawl scan run with defaults', async () => {
      const { body } = await request(app.getHttpServer())
        .post('/v1/scans')
        .set(authHeader())
        .send({
          mode: ScanMode.CRAWL,
          startUrls: ['https://example.com'],
        })
        .expect(201);

      expect(body.mode).toBe(ScanMode.CRAWL);
      expect(body.crawlOptions.maxPages).toBe(250);
      expect(body.crawlOptions.maxDepth).toBe(4);
      expect(body.crawlOptions.strategy).toBe('same-hostname');
    });

    it('queues a job after creating', async () => {
      const { body } = await request(app.getHttpServer())
        .post('/v1/scans')
        .set(authHeader())
        .send({
          mode: ScanMode.SINGLE_URL,
          url: 'https://example.com',
        })
        .expect(201);

      expect(mockAddScanJob).toHaveBeenCalledWith(body.id);
    });

    it('returns 400 for invalid mode payload combinations', () =>
      request(app.getHttpServer())
        .post('/v1/scans')
        .set(authHeader())
        .send({
          mode: ScanMode.SINGLE_URL,
          url: 'https://example.com',
          crawlOptions: { maxPages: 10 },
        })
        .expect(400));

    it('returns 400 when crawl globs contains duplicates', () =>
      request(app.getHttpServer())
        .post('/v1/scans')
        .set(authHeader())
        .send({
          mode: ScanMode.CRAWL,
          startUrls: ['https://example.com'],
          crawlOptions: {
            globs: [
              'https://example.com/docs/**',
              'https://example.com/docs/**',
            ],
          },
        })
        .expect(400));

    it('returns 400 when url_list has fewer than 2 URLs', () =>
      request(app.getHttpServer())
        .post('/v1/scans')
        .set(authHeader())
        .send({
          mode: ScanMode.URL_LIST,
          urls: ['https://example.com'],
        })
        .expect(400));

    it('returns 400 when url_list contains duplicate URLs', () =>
      request(app.getHttpServer())
        .post('/v1/scans')
        .set(authHeader())
        .send({
          mode: ScanMode.URL_LIST,
          urls: ['https://example.com', 'https://example.com'],
        })
        .expect(400));

    it('returns 400 when crawl startUrls contains duplicates', () =>
      request(app.getHttpServer())
        .post('/v1/scans')
        .set(authHeader())
        .send({
          mode: ScanMode.CRAWL,
          startUrls: ['https://example.com', 'https://example.com'],
        })
        .expect(400));

    it('returns 400 when scanOptions.ruleIds contains duplicates', () =>
      request(app.getHttpServer())
        .post('/v1/scans')
        .set(authHeader())
        .send({
          mode: ScanMode.SINGLE_URL,
          url: 'https://example.com',
          scanOptions: { ruleIds: ['image-alt', 'image-alt'] },
        })
        .expect(400));

    it('returns 401 without auth', () =>
      request(app.getHttpServer())
        .post('/v1/scans')
        .send({
          mode: ScanMode.SINGLE_URL,
          url: 'https://example.com',
        })
        .expect(401));
  });

  describe('GET /scans', () => {
    it('returns runs with the unified response shape', async () => {
      const { body } = await request(app.getHttpServer())
        .get('/v1/scans')
        .set(authHeader())
        .expect(200);

      expect(body.length).toBeGreaterThan(0);
      for (const run of body) {
        expect(run).toHaveProperty('id');
        expect(run).toHaveProperty('mode');
        expect(run).toHaveProperty('targets');
        expect(run).toHaveProperty('status');
        expect(run).toHaveProperty('scanOptions');
        expect(run).toHaveProperty('progress');
        expect(run).toHaveProperty('violations');
        expect(run).toHaveProperty('totalIssueCount');
        expect(run).toHaveProperty('createdAt');
        expect(run).toHaveProperty('updatedAt');
        expect(run).not.toHaveProperty('language');
        expect(run).not.toHaveProperty('scannerType');
      }
    });

    it('filters by target URL', async () => {
      const { body } = await request(app.getHttpServer())
        .get('/v1/scans?target=https://seeded.example.com')
        .set(authHeader())
        .expect(200);

      expect(body.length).toBeGreaterThanOrEqual(1);
      for (const run of body) {
        expect(run.targets).toContain('https://seeded.example.com');
      }
    });

    it('returns 400 for invalid target URL query', () =>
      request(app.getHttpServer())
        .get('/v1/scans?target=not-a-url')
        .set(authHeader())
        .expect(400));
  });

  describe('GET /scans/:id', () => {
    it('returns grouped violations with pageUrl per issue', async () => {
      const { body } = await request(app.getHttpServer())
        .get(`/v1/scans/${seededScan.id}`)
        .set(authHeader())
        .expect(200);

      expect(body.id).toBe(seededScan.id);
      expect(body.mode).toBe(ScanMode.SINGLE_URL);
      expect(body.status).toBe(ScanStatus.COMPLETED);
      expect(body.totalIssueCount).toBe(3);
      expect(body.violations).toHaveLength(2);

      for (const violation of body.violations) {
        expect(violation.rule).toHaveProperty('id');
        expect(violation.rule).toHaveProperty('description');
        expect(Object.values(IssueImpact)).toContain(violation.impact);
        for (const issue of violation.issues) {
          expect(typeof issue.id).toBe('number');
          expect(typeof issue.pageUrl).toBe('string');
        }
      }
    });

    it('returns 404 for unknown ID', () =>
      request(app.getHttpServer())
        .get('/v1/scans/999999')
        .set(authHeader())
        .expect(404));

    it('returns 400 for non-numeric ID', () =>
      request(app.getHttpServer())
        .get('/v1/scans/abc')
        .set(authHeader())
        .expect(400));

    it('filters violations to a single matching pageUrl', async () => {
      const url = 'https://seeded.example.com';
      const { body } = await request(app.getHttpServer())
        .get(`/v1/scans/${seededScan.id}?pageUrls=${encodeURIComponent(url)}`)
        .set(authHeader())
        .expect(200);

      for (const violation of body.violations) {
        for (const issue of violation.issues) {
          expect(issue.pageUrl).toBe(url);
        }
      }
    });

    it('filters violations to any of multiple pageUrls when repeated params are provided', async () => {
      const url1 = 'https://seeded.example.com';
      const url2 = 'https://seeded.example.com/about';
      const { body } = await request(app.getHttpServer())
        .get(
          `/v1/scans/${seededScan.id}?pageUrls=${encodeURIComponent(url1)}&pageUrls=${encodeURIComponent(url2)}`,
        )
        .set(authHeader())
        .expect(200);

      expect(body.totalIssueCount).toBe(3);
      for (const violation of body.violations) {
        for (const issue of violation.issues) {
          expect([url1, url2]).toContain(issue.pageUrl);
        }
      }
    });

    it('returns empty violations when pageUrl matches no issues', async () => {
      const { body } = await request(app.getHttpServer())
        .get(
          `/v1/scans/${seededScan.id}?pageUrls=https://no-match.example.com/`,
        )
        .set(authHeader())
        .expect(200);

      expect(body.violations).toHaveLength(0);
      expect(body.totalIssueCount).toBe(0);
    });

    it('returns 400 for invalid pageUrl query param', () =>
      request(app.getHttpServer())
        .get(`/v1/scans/${seededScan.id}?pageUrls=not-a-url`)
        .set(authHeader())
        .expect(400));
  });

  describe('DELETE /scans/:id', () => {
    it('deletes a scan and cascades its issues', async () => {
      const scan = await seedCompletedScan(dataSource);

      await request(app.getHttpServer())
        .delete(`/v1/scans/${scan.id}`)
        .set(authHeader())
        .expect(204);

      await request(app.getHttpServer())
        .get(`/v1/scans/${scan.id}`)
        .set(authHeader())
        .expect(404);

      const remainingIssues = await dataSource
        .getRepository(Issue)
        .count({ where: { scan: { id: scan.id } } });
      expect(remainingIssues).toBe(0);
    });

    it('returns 404 for unknown ID', () =>
      request(app.getHttpServer())
        .delete('/v1/scans/999999')
        .set(authHeader())
        .expect(404));

    it('returns 401 without token', () =>
      request(app.getHttpServer()).delete('/v1/scans/1').expect(401));
  });

  describe('GET /rules', () => {
    it('returns axe rules', async () => {
      const { body } = await request(app.getHttpServer())
        .get('/v1/rules')
        .set(authHeader())
        .expect(200);

      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(100);
      expect(body[0]).toHaveProperty('id');
      expect(body[0]).toHaveProperty('description');
      expect(body[0]).toHaveProperty('tags');
    });
  });

  describe('Cleanup endpoints', () => {
    it('POST /cleanup returns the deletion result', async () => {
      const { body } = await request(app.getHttpServer())
        .post('/v1/cleanup')
        .set(authHeader())
        .expect(200);

      expect(typeof body.deletedScans).toBe('number');
      expect(typeof body.cutoffDate).toBe('string');
    });

    it('GET /cleanup/policy returns the retention policy', async () => {
      const { body } = await request(app.getHttpServer())
        .get('/v1/cleanup/policy')
        .set(authHeader())
        .expect(200);

      expect(typeof body.enabled).toBe('boolean');
      expect(typeof body.retentionDays).toBe('number');
      expect(typeof body.interval).toBe('string');
    });
  });

  describe('GET /api-json', () => {
    it('exposes OpenAPI with scan paths', async () => {
      const { body } = await request(app.getHttpServer())
        .get('/api-json')
        .expect(200);

      expect(body.openapi).toMatch(/^3\./);
      expect(body.paths['/v1/scans']).toBeDefined();
      expect(body.paths['/v1/scans/{id}']).toBeDefined();
    });

    it('documents mode-based start payload with oneOf', async () => {
      const { body } = await request(app.getHttpServer())
        .get('/api-json')
        .expect(200);

      const requestBodySchema =
        body.paths['/v1/scans'].post.requestBody.content['application/json']
          .schema;
      expect(requestBodySchema.oneOf).toBeDefined();
      expect(requestBodySchema.discriminator.propertyName).toBe('mode');
    });

    it('documents request examples and operationIds for API usability', async () => {
      const { body } = await request(app.getHttpServer())
        .get('/api-json')
        .expect(200);

      const scanPost = body.paths['/v1/scans'].post;
      const requestContent = scanPost.requestBody.content['application/json'];

      expect(scanPost.operationId).toBe('createScan');
      expect(body.paths['/v1/scans'].get.operationId).toBe('listScans');
      expect(body.paths['/v1/scans/{id}'].get.operationId).toBe('getScanById');
      expect(body.paths['/v1/rules'].get.operationId).toBe('listRules');
      expect(body.paths['/v1/cleanup'].post.operationId).toBe('triggerCleanup');
      expect(body.paths['/v1/cleanup/policy'].get.operationId).toBe(
        'getCleanupPolicy',
      );

      expect(requestContent.examples).toBeDefined();
      expect(requestContent.examples.singleUrl).toBeDefined();
      expect(requestContent.examples.urlList).toBeDefined();
      expect(requestContent.examples.crawl).toBeDefined();
    });

    it('documents report endpoints with correct content types', async () => {
      const { body } = await request(app.getHttpServer())
        .get('/api-json')
        .expect(200);

      const htmlPath = body.paths['/v1/scans/{id}/reports/html'];
      const pdfPath = body.paths['/v1/scans/{id}/reports/pdf'];
      expect(htmlPath.get.responses['200'].content['text/html']).toBeDefined();
      expect(
        pdfPath.get.responses['200'].content['application/pdf'],
      ).toBeDefined();
    });
  });

  describe('GET /scans/:id/reports/html', () => {
    it('returns 200 with text/html content type', async () => {
      const res = await request(app.getHttpServer())
        .get(`/v1/scans/${seededScan.id}/reports/html`)
        .set(authHeader())
        .expect(200);

      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toContain('<!DOCTYPE html>');
      expect(res.text).toContain(`Scan #${seededScan.id}`);
    });

    it('includes violation data in the report', async () => {
      const res = await request(app.getHttpServer())
        .get(`/v1/scans/${seededScan.id}/reports/html`)
        .set(authHeader())
        .expect(200);

      expect(res.text).toContain('color-contrast');
      expect(res.text).toContain('serious');
    });

    it('returns 404 for unknown scan', async () => {
      await request(app.getHttpServer())
        .get('/v1/scans/99999/reports/html')
        .set(authHeader())
        .expect(404);
    });

    it('returns 401 when auth token is missing', async () => {
      await request(app.getHttpServer())
        .get(`/v1/scans/${seededScan.id}/reports/html`)
        .expect(401);
    });
  });

  describe('GET /scans/:id/reports/pdf', () => {
    it('returns 200 with application/pdf content type', async () => {
      const res = await request(app.getHttpServer())
        .get(`/v1/scans/${seededScan.id}/reports/pdf`)
        .set(authHeader())
        .expect(200);

      expect(res.headers['content-type']).toMatch(/application\/pdf/);
      expect(res.headers['content-disposition']).toContain(
        `scan-${seededScan.id}-report.pdf`,
      );
    });

    it('returns 404 for unknown scan', async () => {
      await request(app.getHttpServer())
        .get('/v1/scans/99999/reports/pdf')
        .set(authHeader())
        .expect(404);
    });

    it('returns 401 when auth token is missing', async () => {
      await request(app.getHttpServer())
        .get(`/v1/scans/${seededScan.id}/reports/pdf`)
        .expect(401);
    });
  });
});
