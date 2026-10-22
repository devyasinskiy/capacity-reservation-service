import type { Server } from 'node:http';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApiApp } from '../../src/bootstrap';
import { CurrentPrincipal, Public, RequireScopes } from '../../src/modules/auth/decorators';
import type { Principal } from '../../src/modules/auth/principal';
import { Scope } from '../../src/modules/auth/scopes';
import { DEV_PUBLIC_KEY, makeToken, ROGUE_PRIVATE_KEY } from '../support/tokens';

// Probe routes exist only in this test; business routes arrive in M4.
@Controller('probe')
class ProbeController {
  @Get('read')
  @RequireScopes(Scope.READ)
  read(@CurrentPrincipal() p: Principal) {
    return { subject: p.subject, tenantId: p.tenantId, scopes: [...p.scopes] };
  }

  @Get('write')
  @RequireScopes(Scope.READ, Scope.WRITE)
  write() {
    return { ok: true };
  }

  @Get('undeclared')
  undeclared() {
    return { ok: true };
  }

  @Get('public')
  @Public()
  open() {
    return { ok: true };
  }
}

const http = (app: INestApplication): Server => app.getHttpServer() as Server;

describe('Authentication & authorization (e2e)', () => {
  let app: NestExpressApplication;
  const get = (path: string, token?: string) => {
    const req = request(http(app)).get(`/v1/probe/${path}`);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ProbeController],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApiApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('accepts a valid token and exposes the principal', async () => {
    const res = await get('read', makeToken({ tenant: 't-42', scopes: [Scope.READ] })).expect(200);
    expect(res.body).toEqual({ subject: 'test-user', tenantId: 't-42', scopes: [Scope.READ] });
  });

  it('tolerates small clock skew on exp (JWT_CLOCK_TOLERANCE_SECONDS)', async () => {
    await get('read', makeToken({ sign: { expiresIn: -10 } })).expect(200);
  });

  it('allows explicitly public routes without a token', async () => {
    await get('public').expect(200);
  });

  describe('401 UNAUTHENTICATED as problem+json', () => {
    const now = Math.floor(Date.now() / 1000);
    const cases: Array<[string, () => string | undefined]> = [
      ['no token', () => undefined],
      ['garbage token', () => 'not-a-jwt'],
      ['signed by another key', () => makeToken({ key: ROGUE_PRIVATE_KEY })],
      ['expired beyond clock tolerance', () => makeToken({ sign: { expiresIn: -120 } })],
      ['wrong issuer', () => makeToken({ sign: { issuer: 'evil' } })],
      ['wrong audience', () => makeToken({ sign: { audience: 'other-api' } })],
      ['missing tenant claim', () => makeToken({ claims: { tid: undefined } })],
      // alg-confusion: HS256 "signed" with the public key must not verify (ADR-007)
      [
        'HS256 signed with the public key',
        () =>
          jwt.sign({ tid: 't-1', scope: Scope.READ }, DEV_PUBLIC_KEY, {
            algorithm: 'HS256',
            subject: 'x',
            issuer: 'capacity-dev-issuer',
            audience: 'program-capacity-api',
            expiresIn: 300,
          }),
      ],
      [
        'alg none',
        () => jwt.sign({ tid: 't-1', sub: 'x', exp: now + 300 }, '', { algorithm: 'none' }),
      ],
    ];

    it.each(cases)('%s', async (_label, token) => {
      const res = await get('read', token()).expect(401);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.headers['www-authenticate']).toMatch(/^Bearer/);
      expect(res.body).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
      expect(res.body).toHaveProperty('correlationId', expect.any(String));
      // Never reveal why verification failed.
      expect(JSON.stringify(res.body)).not.toMatch(/expired|signature|audience|issuer|malformed/i);
    });
  });

  describe('403 INSUFFICIENT_SCOPE', () => {
    it('rejects a token missing one of the required scopes', async () => {
      const res = await get('write', makeToken({ scopes: [Scope.READ] })).expect(403);
      expect(res.body).toMatchObject({ status: 403, code: 'INSUFFICIENT_SCOPE' });
    });

    it('accepts when all required scopes are present', async () => {
      await get('write', makeToken({ scopes: [Scope.READ, Scope.WRITE] })).expect(200);
    });

    it('fails closed for an authenticated route that declares no scopes', async () => {
      const token = makeToken({ scopes: [Scope.READ, Scope.WRITE, Scope.AUDIT] });
      await get('undeclared', token).expect(403);
    });
  });

  it('returns problem+json 404 for unknown authenticated routes', async () => {
    const res = await request(http(app))
      .get('/v1/nope')
      .set('Authorization', `Bearer ${makeToken()}`)
      .expect(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});
