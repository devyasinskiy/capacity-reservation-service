import type { Kysely } from 'kysely';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { Scope } from '../../src/modules/auth/scopes';
import {
  CAPACITY_STORE,
  type CapacityStore,
} from '../../src/modules/capacity/application/ports/capacity-store';
import { KyselyCapacityStore } from '../../src/modules/capacity/infrastructure/persistence/kysely-capacity-store';
import { auditLedger } from '../../src/modules/capacity/infrastructure/persistence/ledger-audit';
import { KYSELY } from '../../src/shared/database/database';
import type { Database } from '../../src/shared/database/database.types';
import { createApiApp, givenProgram, http } from '../support/app';
import { holdProgramLock } from '../support/locks';
import { makeToken } from '../support/tokens';

const money = (amountMinor: string, currency: string) => ({ amountMinor, currency });

describe('Concurrency over HTTP (e2e)', () => {
  describe('N parallel requests against one program', () => {
    let app: NestExpressApplication;
    beforeAll(async () => {
      app = await createApiApp();
    });
    afterAll(async () => {
      await app?.close();
    });

    it('100 simultaneous POST /reservations for a limit fitting 37 → exactly 37 × 201, 63 × 409', async () => {
      const key = await givenProgram(app, { limitMinor: 3_700n });
      const auth = `Bearer ${makeToken({ tenant: key.tenantId, scopes: [Scope.READ, Scope.WRITE] })}`;

      const responses = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          request(http(app))
            .post(`/v1/programs/${key.programId}/reservations`)
            .set('Authorization', auth)
            .send({ invoiceId: `INV-${i}`, amount: money('100', 'USD') }),
        ),
      );
      const byStatus = responses.reduce<Record<number, number>>((acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        return acc;
      }, {});
      expect(byStatus).toEqual({ 201: 37, 409: 63 });
      expect(
        responses
          .filter((r) => r.status === 409)
          .every((r) => r.body.code === 'INSUFFICIENT_CAPACITY'),
      ).toBe(true);

      const availability = await request(http(app))
        .get(`/v1/programs/${key.programId}/availability`)
        .set('Authorization', auth)
        .expect(200);
      expect(availability.body).toMatchObject({
        reserved: money('3700', 'USD'),
        available: money('0', 'USD'),
      });
      expect(
        (await auditLedger(app.get<Kysely<Database>>(KYSELY), { tenantId: key.tenantId }))
          .mismatches,
      ).toEqual([]);
    });
  });

  describe('lock contention beyond lock_timeout', () => {
    let app: NestExpressApplication;
    beforeAll(async () => {
      // Same app, but the store gives up on the program lock after 100ms (ADR-005).
      app = await createApiApp([], (builder) =>
        builder.overrideProvider(CAPACITY_STORE).useFactory({
          inject: [KYSELY],
          factory: (db: Kysely<Database>) =>
            new KyselyCapacityStore(db, { lockTimeoutMs: 100, statementTimeoutMs: 5_000 }),
        }),
      );
    });
    afterAll(async () => {
      await app?.close();
    });

    it('sheds load with 503 SERVICE_UNAVAILABLE + Retry-After and writes nothing', async () => {
      const key = await givenProgram(app);
      const auth = `Bearer ${makeToken({ tenant: key.tenantId, scopes: [Scope.READ, Scope.WRITE] })}`;
      const store = app.get<CapacityStore>(CAPACITY_STORE);

      // Hold the program lock (e.g. a long reconciliation) while a client tries to reserve.
      const lock = holdProgramLock(store, key);
      await lock.acquired;

      const res = await request(http(app))
        .post(`/v1/programs/${key.programId}/reservations`)
        .set('Authorization', auth)
        .send({ invoiceId: 'INV-1', amount: money('100', 'USD') })
        .expect(503);
      lock.release();
      await lock.done;

      expect(res.headers['retry-after']).toBe('1');
      expect(res.body).toMatchObject({ code: 'SERVICE_UNAVAILABLE', status: 503 });

      // The client retries after the lock is free and succeeds; nothing was half-written before.
      await request(http(app))
        .post(`/v1/programs/${key.programId}/reservations`)
        .set('Authorization', auth)
        .send({ invoiceId: 'INV-1', amount: money('100', 'USD') })
        .expect(201);
      const ledger = await app
        .get<Kysely<Database>>(KYSELY)
        .selectFrom('ledger_entries')
        .select('type')
        .where('tenant_id', '=', key.tenantId)
        .execute();
      expect(ledger.map((l) => l.type)).toEqual(['LIMIT_SET', 'RESERVE']);
    });
  });
});
