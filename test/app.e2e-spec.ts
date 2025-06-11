import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('Scan API (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });

  it('/scans (GET)', () => {
    return request(app.getHttpServer()).get('/scans').expect(200).expect([]);
  });

  it('/scans (POST)', () => {
    return request(app.getHttpServer())
      .post('/scans')
      .send({
        url: 'https://example.com',
        language: 'en',
      })
      .expect(201);
  });
});
