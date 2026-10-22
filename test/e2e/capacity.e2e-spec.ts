import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { Scope } from '../../src/modules/auth/scopes';
import { ApplyTreasuryMessage } from '../../src/modules/capacity/application/apply-treasury-message';
import { parseTreasuryMessage } from '../../src/modules/capacity/messaging/treasury-message.schema';
import { createApiApp, givenProgram, http } from '../support/app';
import { treasuryMessages } from '../support/treasury-messages';
import { makeToken } from '../support/tokens';

const ALL = [Scope.READ, Scope.WRITE, Scope.AUDIT];
const money = (amountMinor: string, currency: string) => ({ amountMinor, currency });

describe('Capacity API (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApiApp();
  });
  afterAll(async () => {
    await app?.close();
  });

  /** A client bound to one tenant/program. */
  async function client(opts: Parameters<typeof givenProgram>[1] = {}, scopes = ALL) {
    const key = await givenProgram(app, opts);
    const auth = `Bearer ${makeToken({ tenant: key.tenantId, scopes })}`;
    const base = `/v1/programs/${key.programId}`;
    return {
      key,
      auth,
      availability: () => request(http(app)).get(`${base}/availability`).set('Authorization', auth),
      reserve: (body: object, idemKey?: string) => {
        const r = request(http(app))
          .post(`${base}/reservations`)
          .set('Authorization', auth)
          .send(body);
        return idemKey ? r.set('Idempotency-Key', idemKey) : r;
      },
      release: (id: string, body: object | undefined, idemKey?: string) => {
        const r = request(http(app))
          .post(`${base}/reservations/${id}/releases`)
          .set('Authorization', auth);
        if (idemKey) void r.set('Idempotency-Key', idemKey);
        return body ? r.send(body) : r;
      },
      list: (query = '') =>
        request(http(app)).get(`${base}/reservations${query}`).set('Authorization', auth),
      get: (id: string) =>
        request(http(app)).get(`${base}/reservations/${id}`).set('Authorization', auth),
      ledger: (query = '') =>
        request(http(app)).get(`${base}/ledger${query}`).set('Authorization', auth),
    };
  }

  describe('availability', () => {
    it('returns limit, reserved, available as minor-unit strings', async () => {
      const c = await client({ limitMinor: 1_000_000_000n });
      const res = await c.availability().expect(200);
      expect(res.body).toMatchObject({
        programId: 'PRG-1',
        currency: 'USD',
        limit: money('1000000000', 'USD'),
        reserved: money('0', 'USD'),
        available: money('1000000000', 'USD'),
        overLimit: false,
        version: '0',
      });
      expect(Date.parse(res.body.asOf)).not.toBeNaN();
    });

    it("treats another tenant's program as not found", async () => {
      const c = await client();
      const stranger = makeToken({ tenant: 't-stranger', scopes: ALL });
      const res = await request(http(app))
        .get(`/v1/programs/${c.key.programId}/availability`)
        .set('Authorization', `Bearer ${stranger}`)
        .expect(404);
      expect(res.body.code).toBe('PROGRAM_NOT_FOUND');
    });

    it('requires capacity:read', async () => {
      const c = await client({}, [Scope.WRITE]);
      expect((await c.availability().expect(403)).body.code).toBe('INSUFFICIENT_SCOPE');
    });

    it('validates the programId path parameter', async () => {
      const c = await client();
      const res = await request(http(app))
        .get('/v1/programs/bad%20id!/availability')
        .set('Authorization', c.auth)
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('reserve', () => {
    it('converts at a locked FX rate (CEIL), returns 201 + Location, and reduces availability', async () => {
      const c = await client({ limitMinor: 1_000_000n });
      const res = await c
        .reserve({ invoiceId: 'INV-1', amount: money('10000', 'EUR') })
        .expect(201);
      expect(res.headers.location).toBe(`/v1/programs/PRG-1/reservations/${res.body.id}`);
      expect(res.body).toMatchObject({
        invoiceId: 'INV-1',
        origin: 'LOCAL',
        status: 'ACTIVE',
        invoiceAmount: money('10000', 'EUR'),
        programAmount: money('10825', 'USD'),
        outstandingProgramAmount: money('10825', 'USD'),
        fx: { rate: '1.0825', source: 'STUB' },
      });
      const after = await c.availability().expect(200);
      expect(after.body.available).toEqual(money(String(1_000_000 - 10825), 'USD'));
      expect(after.body.version).toBe('1');
    });

    it('returns the existing reservation (200, Idempotent-Replayed) for an identical retry without a key', async () => {
      const c = await client();
      const first = await c
        .reserve({ invoiceId: 'INV-1', amount: money('500', 'USD') })
        .expect(201);
      const again = await c
        .reserve({ invoiceId: 'INV-1', amount: money('500', 'USD') })
        .expect(200);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body.id).toBe(first.body.id);
      expect((await c.availability()).body.reserved).toEqual(money('500', 'USD'));
    });

    it('rejects a different amount for an invoice with a live reservation', async () => {
      const c = await client();
      await c.reserve({ invoiceId: 'INV-1', amount: money('500', 'USD') }).expect(201);
      const res = await c.reserve({ invoiceId: 'INV-1', amount: money('600', 'USD') }).expect(409);
      expect(res.body.code).toBe('RESERVATION_CONFLICT');
    });

    it('replays the stored response for the same Idempotency-Key and rejects key reuse', async () => {
      const c = await client();
      const body = { invoiceId: 'INV-K', amount: money('700', 'USD') };
      const first = await c.reserve(body, 'key-1').expect(201);
      const replay = await c.reserve(body, 'key-1').expect(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);

      const reused = await c
        .reserve({ invoiceId: 'INV-OTHER', amount: money('1', 'USD') }, 'key-1')
        .expect(422);
      expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('resolves a concurrent Idempotency-Key race across two programs: one wins, the other is a reuse', async () => {
      const a = await client();
      // Second program of the same tenant: a different row lock, so only the key PK serialises them.
      await givenProgram(app, { tenantId: a.key.tenantId, programId: 'PRG-2' });
      const fire = (programId: string) =>
        request(http(app))
          .post(`/v1/programs/${programId}/reservations`)
          .set('Authorization', a.auth)
          .set('Idempotency-Key', 'shared-key')
          .send({ invoiceId: 'INV-RACE', amount: money('10', 'USD') });

      const results = await Promise.all([fire('PRG-1'), fire('PRG-2')]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
      expect(results.find((r) => r.status === 422)?.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('rejects reservations beyond available capacity with details', async () => {
      const c = await client({ limitMinor: 1000n });
      await c.reserve({ invoiceId: 'INV-1', amount: money('900', 'USD') }).expect(201);
      const res = await c.reserve({ invoiceId: 'INV-2', amount: money('101', 'USD') }).expect(409);
      expect(res.body).toMatchObject({
        code: 'INSUFFICIENT_CAPACITY',
        details: { requestedMinor: '101', availableMinor: '100', currency: 'USD' },
      });
      expect(res.headers['content-type']).toMatch(/problem\+json/);
    });

    it.each([
      [
        'unsupported currency',
        { invoiceId: 'I', amount: money('1', 'XAU') },
        422,
        'CURRENCY_NOT_SUPPORTED',
      ],
      ['zero amount', { invoiceId: 'I', amount: money('0', 'USD') }, 400, 'INVALID_AMOUNT'],
      [
        'decimal amount',
        { invoiceId: 'I', amount: money('1.50', 'USD') },
        400,
        'VALIDATION_FAILED',
      ],
      [
        'numeric amount',
        { invoiceId: 'I', amount: { amountMinor: 150, currency: 'USD' } },
        400,
        'VALIDATION_FAILED',
      ],
      ['missing amount', { invoiceId: 'I' }, 400, 'VALIDATION_FAILED'],
      [
        'unknown field',
        { invoiceId: 'I', amount: money('1', 'USD'), programId: 'X' },
        400,
        'VALIDATION_FAILED',
      ],
      ['bad invoiceId', { invoiceId: 'a b', amount: money('1', 'USD') }, 400, 'VALIDATION_FAILED'],
    ])('rejects %s', async (_l, body, status, code) => {
      const c = await client();
      const res = await c.reserve(body).expect(status);
      expect(res.body.code).toBe(code);
    });

    it('lists field errors for validation failures', async () => {
      const c = await client();
      const res = await c
        .reserve({ invoiceId: 'I', amount: { amountMinor: '-1', currency: 'usd' } })
        .expect(400);
      expect(res.body.errors.map((e: { field: string }) => e.field).sort()).toEqual([
        'amount.amountMinor',
        'amount.currency',
      ]);
    });

    it('rejects malformed JSON without echoing the payload', async () => {
      const c = await client();
      const res = await request(http(app))
        .post(`/v1/programs/${c.key.programId}/reservations`)
        .set('Authorization', c.auth)
        .set('Content-Type', 'application/json')
        .send('{"invoiceId": "secret-123",')
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(res.body)).not.toContain('secret-123');
    });

    it('requires capacity:write', async () => {
      const c = await client({}, [Scope.READ]);
      await c.reserve({ invoiceId: 'I', amount: money('1', 'USD') }).expect(403);
    });
  });

  describe('release', () => {
    it('partially releases pro-rata, then frees the exact remainder (ADR-004)', async () => {
      const c = await client();
      // 0.03 EUR → ceil(3.2475) = 4 cents locked
      const { body: r } = await c
        .reserve({ invoiceId: 'INV-1', amount: money('3', 'EUR') })
        .expect(201);
      expect(r.programAmount).toEqual(money('4', 'USD'));

      const p1 = await c.release(r.id, { amount: money('1', 'EUR') }, 'rel-1').expect(200);
      expect(p1.body.release.freedProgramAmount).toEqual(money('1', 'USD')); // floor(4/3)
      expect(p1.body.reservation.status).toBe('PARTIALLY_RELEASED');

      const p2 = await c.release(r.id, undefined, 'rel-2').expect(200); // remainder
      expect(p2.body.release).toEqual({
        releasedInvoiceAmount: money('2', 'EUR'),
        freedProgramAmount: money('3', 'USD'),
      });
      expect(p2.body.reservation.status).toBe('RELEASED');
      expect((await c.availability()).body.reserved).toEqual(money('0', 'USD'));
    });

    it('replays a release for the same Idempotency-Key without releasing twice', async () => {
      const c = await client();
      const { body: r } = await c
        .reserve({ invoiceId: 'INV-1', amount: money('1000', 'USD') })
        .expect(201);
      const first = await c.release(r.id, { amount: money('400', 'USD') }, 'rel-x').expect(200);
      const replay = await c.release(r.id, { amount: money('400', 'USD') }, 'rel-x').expect(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect((await c.availability()).body.reserved).toEqual(money('600', 'USD'));
    });

    it('requires an Idempotency-Key', async () => {
      const c = await client();
      const { body: r } = await c
        .reserve({ invoiceId: 'INV-1', amount: money('1', 'USD') })
        .expect(201);
      expect((await c.release(r.id, {}).expect(400)).body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it.each([
      ['over-release', { amount: money('1001', 'USD') }, 422, 'OVER_RELEASE'],
      ['wrong currency', { amount: money('1', 'EUR') }, 422, 'CURRENCY_MISMATCH'],
    ])('rejects %s', async (_l, body, status, code) => {
      const c = await client();
      const { body: r } = await c
        .reserve({ invoiceId: 'INV-1', amount: money('1000', 'USD') })
        .expect(201);
      expect((await c.release(r.id, body, 'k').expect(status)).body.code).toBe(code);
    });

    it('rejects a new release after full release, and lets the invoice be reserved again', async () => {
      const c = await client();
      const { body: r } = await c
        .reserve({ invoiceId: 'INV-1', amount: money('10', 'USD') })
        .expect(201);
      await c.release(r.id, undefined, 'k1').expect(200);
      expect((await c.release(r.id, undefined, 'k2').expect(409)).body.code).toBe(
        'RESERVATION_ALREADY_RELEASED',
      );
      const again = await c.reserve({ invoiceId: 'INV-1', amount: money('10', 'USD') }).expect(201);
      expect(again.body.id).not.toBe(r.id);
    });

    it('returns 404 for unknown reservations and 400 for malformed ids', async () => {
      const c = await client();
      const unknown = await c
        .release('00000000-0000-4000-8000-000000000000', undefined, 'k')
        .expect(404);
      expect(unknown.body.code).toBe('RESERVATION_NOT_FOUND');
      await c.release('not-a-uuid', undefined, 'k').expect(400);
    });
  });

  describe('queries', () => {
    it('gets one reservation and pages through the list with a status filter', async () => {
      const c = await client();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(
          (await c.reserve({ invoiceId: `INV-${i}`, amount: money('10', 'USD') }).expect(201)).body
            .id,
        );
      }
      await c.release(ids[0]!, undefined, 'k').expect(200);

      expect((await c.get(ids[1]!).expect(200)).body.id).toBe(ids[1]);

      const page1 = await c.list('?limit=2').expect(200);
      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.nextCursor).toEqual(expect.any(String));
      const page2 = await c.list(`?limit=2&cursor=${page1.body.nextCursor}`).expect(200);
      const page3 = await c.list(`?limit=2&cursor=${page2.body.nextCursor}`).expect(200);
      expect(page3.body.nextCursor).toBeNull();
      const all = [...page1.body.items, ...page2.body.items, ...page3.body.items].map(
        (r: { id: string }) => r.id,
      );
      expect(new Set(all)).toEqual(new Set(ids));

      const released = await c.list('?status=RELEASED').expect(200);
      expect(released.body.items.map((r: { id: string }) => r.id)).toEqual([ids[0]]);
    });

    it('rejects a tampered cursor', async () => {
      const c = await client();
      expect((await c.list('?cursor=bm9wZQ').expect(400)).body.code).toBe('INVALID_CURSOR');
    });

    it('exposes the ledger (capacity:audit) with correlation IDs, explaining the balance', async () => {
      const c = await client({ limitMinor: 5000n });
      const { body: r } = await c
        .reserve({ invoiceId: 'INV-1', amount: money('1200', 'USD') })
        .set('x-correlation-id', 'corr-abc')
        .expect(201);
      await c.release(r.id, { amount: money('200', 'USD') }, 'rel-1').expect(200);

      const res = await c.ledger().expect(200);
      expect(res.body.items.map((e: { type: string }) => e.type)).toEqual([
        'RELEASE',
        'RESERVE',
        'LIMIT_SET',
      ]);
      expect(res.body.items[1]).toMatchObject({
        reservationId: r.id,
        reservedDelta: money('1200', 'USD'),
        source: 'HTTP',
        correlationId: 'corr-abc',
      });
      expect(res.body.items[0]).toMatchObject({
        reservedDelta: money('-200', 'USD'),
        sourceRef: 'rel-1',
      });
      const sum = res.body.items.reduce(
        (acc: bigint, e: { reservedDelta: { amountMinor: string } }) =>
          acc + BigInt(e.reservedDelta.amountMinor),
        0n,
      );
      expect(sum.toString()).toBe((await c.availability()).body.reserved.amountMinor);
    });

    it('lists reconciliation discrepancies (capacity:audit) with money in program currency', async () => {
      const c = await client();
      const { body: r } = await c
        .reserve({ invoiceId: 'INV-1', amount: money('300', 'USD') })
        .expect(201);
      // Treasury's snapshot (as of now) misses our reservation and lists one we never saw.
      const apply = app.get(ApplyTreasuryMessage);
      const msgs = treasuryMessages(c.key.tenantId, c.key.programId);
      const [part] = msgs.snapshot({
        asOf: new Date(Date.now() + 1000),
        limitMinor: '1000000',
        reservations: [
          { origin: 'EXTERNAL', ref: 'T-9', invoiceId: 'INV-T9', outstandingMinor: '50' },
        ],
        version: 2,
      });
      await apply.execute(parseTreasuryMessage(JSON.stringify(part)), {
        topic: 't',
        partition: 0,
        offset: '0',
      });

      const res = await request(http(app))
        .get(`/v1/programs/${c.key.programId}/discrepancies?status=PENDING`)
        .set('Authorization', c.auth)
        .expect(200);
      // Our reservation is within the default 5-minute grace window → UNCERTAIN, not listed.
      expect(res.body.items).toEqual([
        expect.objectContaining({
          kind: 'MISSING_LOCALLY',
          origin: 'EXTERNAL',
          reservationRef: 'T-9',
          treasuryOutstanding: money('50', 'USD'),
          localOutstanding: null,
          strikes: 1,
          status: 'PENDING',
        }),
      ]);
      expect(r.id).toBeDefined();
      await request(http(app))
        .get(`/v1/programs/${c.key.programId}/discrepancies`)
        .set(
          'Authorization',
          `Bearer ${makeToken({ tenant: c.key.tenantId, scopes: [Scope.READ] })}`,
        )
        .expect(403);
    });

    it('denies the ledger without capacity:audit', async () => {
      const c = await client({}, [Scope.READ, Scope.WRITE]);
      await c.ledger().expect(403);
    });
  });
});
