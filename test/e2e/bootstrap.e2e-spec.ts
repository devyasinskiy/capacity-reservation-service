import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApiApp } from '../../src/bootstrap';
import { createManagementApp } from '../../src/modules/observability/management';

const http = (app: INestApplication): Server => app.getHttpServer() as Server;

describe('Bootstrap (e2e)', () => {
  let api: NestExpressApplication;
  let management: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    api = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApiApp(api);
    await api.init();
    management = await createManagementApp(api);
    await management.init();
  });

  afterAll(async () => {
    await management?.close();
    await api?.close();
  });

  it('serves liveness on the management app', async () => {
    const res = await request(http(management)).get('/health/live').expect(200);
    expect(res.body).toMatchObject({ status: 'ok' });
  });

  it('reports readiness when the database is reachable', async () => {
    const res = await request(http(management)).get('/health/ready').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', info: { database: { status: 'up' } } });
  });

  it('does not expose health on the public API port', async () => {
    await request(http(api)).get('/health/live').expect(404);
    await request(http(api)).get('/v1/health/live').expect(404);
  });

  it('echoes a valid caller correlation ID and generates one otherwise', async () => {
    const echoed = await request(http(api)).get('/v1/nope').set('x-correlation-id', 'abc-123');
    expect(echoed.headers['x-correlation-id']).toBe('abc-123');

    const generated = await request(http(api)).get('/v1/nope');
    expect(generated.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not advertise the framework', async () => {
    const res = await request(http(api)).get('/v1/nope');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
