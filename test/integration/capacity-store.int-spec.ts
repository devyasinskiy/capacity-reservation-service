import { randomUUID } from 'node:crypto';
import { type Kysely, sql } from 'kysely';
import { DomainError } from '../../src/shared/errors/domain-error';
import { RetryableError } from '../../src/shared/errors/retryable-error';
import type { Database } from '../../src/shared/database/database.types';
import { FxRate } from '../../src/shared/money/fx-rate';
import { Money } from '../../src/shared/money/money';
import type { ProgramKey } from '../../src/modules/capacity/application/ports/capacity-store';
import { Program } from '../../src/modules/capacity/domain/program';
import { KyselyCapacityStore } from '../../src/modules/capacity/infrastructure/persistence/kysely-capacity-store';
import { testDatabase, uniqueTenant } from '../support/db';
import { holdProgramLock, signal } from '../support/locks';

const HTTP = { source: 'HTTP', sourceRef: 'idem-1', correlationId: 'corr-1' } as const;
const now = new Date('2026-10-11T12:00:00Z');
const eurUsd = FxRate.of({ base: 'EUR', quote: 'USD', rate: '1.0825', source: 'STUB', asOf: now });

describe('KyselyCapacityStore (integration)', () => {
  let db: Kysely<Database>;
  let store: KyselyCapacityStore;

  beforeAll(() => {
    db = testDatabase();
    store = new KyselyCapacityStore(db, { lockTimeoutMs: 2000, statementTimeoutMs: 5000 });
  });
  afterAll(() => db.destroy());

  async function newProgram(limitMinor = 1_000_000n, currency = 'USD'): Promise<ProgramKey> {
    const key = { tenantId: uniqueTenant(), programId: 'PRG-1' };
    const { program, movement } = Program.open({
      ...key,
      limit: Money.of(limitMinor, currency),
      version: 1n,
    });
    expect(await store.createProgram(program, movement, { source: 'SYSTEM' })).toBe(true);
    return key;
  }

  const reserveEur = (key: ProgramKey, invoiceId: string, eurMinor: bigint) =>
    store.withLockedProgram(key, HTTP, async (s) => {
      const { reservation, movement } = s.program.reserve({
        reservationId: randomUUID(),
        invoiceId,
        invoiceAmount: Money.of(eurMinor, 'EUR'),
        fxRate: eurUsd,
        now,
      });
      await s.saveReservation(reservation);
      await s.recordMovement(movement);
      return reservation;
    });

  const ledger = (key: ProgramKey) =>
    db
      .selectFrom('ledger_entries')
      .selectAll()
      .where('tenant_id', '=', key.tenantId)
      .where('program_id', '=', key.programId)
      .orderBy('id')
      .execute();

  it('creates a program once, with an opening LIMIT_SET ledger row', async () => {
    const key = await newProgram(500n);
    const { program, movement } = Program.open({ ...key, limit: Money.of(9n, 'USD'), version: 2n });
    expect(await store.createProgram(program, movement, { source: 'SYSTEM' })).toBe(false);

    const loaded = await store.findProgram(key);
    expect(loaded?.limit).toEqual(Money.of(500n, 'USD'));
    expect(await ledger(key)).toMatchObject([
      { type: 'LIMIT_SET', reserved_delta_minor: 0n, limit_after_minor: 500n },
    ]);
  });

  it('persists a reservation, the FX lock, the ledger row and the new balance atomically', async () => {
    const key = await newProgram();
    const r = await reserveEur(key, 'inv-1', 10000n);

    expect((await store.findProgram(key))?.reserved).toEqual(Money.of(10825n, 'USD'));
    const row = await db
      .selectFrom('reservations')
      .selectAll()
      .where('id', '=', r.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      invoice_currency: 'EUR',
      invoice_amount_minor: 10000n,
      program_currency: 'USD',
      program_amount_minor: 10825n,
      fx_rate: '1.082500000000',
      fx_source: 'STUB',
      status: 'ACTIVE',
    });
    const [, reserve] = await ledger(key);
    expect(reserve).toMatchObject({
      type: 'RESERVE',
      reservation_id: r.id,
      reserved_delta_minor: 10825n,
      reserved_after_minor: 10825n,
      source: 'HTTP',
      source_ref: 'idem-1',
      correlation_id: 'corr-1',
    });
  });

  it('round-trips a partially released reservation through the database', async () => {
    const key = await newProgram();
    const r = await reserveEur(key, 'inv-1', 3n); // 0.03 EUR → 4 cents (CEIL of 3.2475)
    await store.withLockedProgram(key, HTTP, async (s) => {
      const loaded = await s.findReservation(r.id);
      const { movement } = s.program.release(loaded!, Money.of(1n, 'EUR'));
      await s.saveReservation(loaded!);
      await s.recordMovement(movement);
    });

    const reloaded = await store.withLockedProgram(key, HTTP, (s) => s.findReservation(r.id));
    expect(reloaded?.status).toBe('PARTIALLY_RELEASED');
    expect(reloaded?.outstandingInvoice).toEqual(Money.of(2n, 'EUR'));
    expect(reloaded?.toState().fx.rate).toBe('1.0825'); // numeric padding normalised
    expect((await store.findProgram(key))?.reserved.minor).toBe(4n - 1n); // floor(4 × 1/3) = 1 freed
  });

  it('writes nothing when the work throws (single transaction)', async () => {
    const key = await newProgram(100n);
    await expect(
      store.withLockedProgram(key, HTTP, async (s) => {
        const { reservation, movement } = s.program.reserve({
          reservationId: randomUUID(),
          invoiceId: 'inv-x',
          invoiceAmount: Money.of(50n, 'USD'),
          fxRate: FxRate.identity('USD', now),
          now,
        });
        await s.saveReservation(reservation);
        await s.recordMovement(movement);
        throw new Error('boom after writes');
      }),
    ).rejects.toThrow('boom after writes');

    expect((await store.findProgram(key))?.reserved.minor).toBe(0n);
    expect(await ledger(key)).toHaveLength(1);
  });

  it('hides programs of other tenants (PROGRAM_NOT_FOUND)', async () => {
    const key = await newProgram();
    const other = { tenantId: uniqueTenant(), programId: key.programId };
    expect(await store.findProgram(other)).toBeNull();
    await expect(
      store.withLockedProgram(other, HTTP, () => Promise.resolve()),
    ).rejects.toMatchObject({
      code: 'PROGRAM_NOT_FOUND',
    });
    await expect(
      store.withLockedProgram(other, HTTP, () => Promise.resolve()),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it('serialises concurrent work on the same program (row lock)', async () => {
    const key = await newProgram();
    const events: string[] = [];
    const firstHasLock = signal();
    const first = store.withLockedProgram(key, HTTP, async () => {
      events.push('first:start');
      firstHasLock.fire();
      await new Promise((r) => setTimeout(r, 300));
      events.push('first:end');
    });
    await firstHasLock.promise;
    const second = store.withLockedProgram(key, HTTP, () => {
      events.push('second:start');
      return Promise.resolve();
    });
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('turns a lock wait beyond lock_timeout into a RetryableError', async () => {
    const key = await newProgram();
    const impatient = new KyselyCapacityStore(db, { lockTimeoutMs: 100, statementTimeoutMs: 5000 });
    const lock = holdProgramLock(store, key);
    await lock.acquired;
    const err: unknown = await impatient
      .withLockedProgram(key, HTTP, () => Promise.resolve())
      .catch((e: unknown) => e);
    lock.release();
    await lock.done;
    expect(err).toBeInstanceOf(RetryableError);
    expect((err as RetryableError).reason).toBe('LOCK_TIMEOUT');
  });

  it('does not block other programs while one is locked', async () => {
    const a = await newProgram();
    const b = await newProgram();
    const impatient = new KyselyCapacityStore(db, { lockTimeoutMs: 100, statementTimeoutMs: 5000 });
    const lock = holdProgramLock(store, a);
    await lock.acquired;
    await expect(impatient.withLockedProgram(b, HTTP, () => Promise.resolve('ok'))).resolves.toBe(
      'ok',
    );
    lock.release();
    await lock.done;
  });

  describe('database safety nets', () => {
    it('ledger is append-only: UPDATE, DELETE and TRUNCATE are rejected', async () => {
      const key = await newProgram();
      const q = (stmt: ReturnType<typeof sql>) => stmt.execute(db);
      await expect(
        q(
          sql`update ledger_entries set reserved_delta_minor = 0 where tenant_id = ${key.tenantId}`,
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        q(sql`delete from ledger_entries where tenant_id = ${key.tenantId}`),
      ).rejects.toThrow(/append-only/);
      await expect(q(sql`truncate ledger_entries cascade`)).rejects.toThrow(/append-only/);
    });

    it('a second live LOCAL reservation for the same invoice violates the partial unique index', async () => {
      const key = await newProgram();
      await reserveEur(key, 'inv-dup', 100n);
      await expect(reserveEur(key, 'inv-dup', 100n)).rejects.toMatchObject({ code: '23505' });
    });

    it('reserved_minor cannot go negative', async () => {
      const key = await newProgram();
      await expect(
        db
          .updateTable('programs')
          .set({ reserved_minor: -1n })
          .where('tenant_id', '=', key.tenantId)
          .execute(),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('ledger timestamps are DB time and monotone per program', async () => {
      const key = await newProgram();
      for (let i = 0; i < 5; i++) await reserveEur(key, `inv-${i}`, 100n);
      const rows = await ledger(key);
      const times = rows.map((r) => r.occurred_at.getTime());
      expect([...times].sort((x, y) => x - y)).toEqual(times);
      const dbNow = await sql<{ now: Date }>`select now()`.execute(db);
      expect(Math.abs(dbNow.rows[0]!.now.getTime() - times.at(-1)!)).toBeLessThan(60_000);
    });

    it('parses int8 as bigint beyond Number.MAX_SAFE_INTEGER', async () => {
      const key = await newProgram(9_007_199_254_740_993n);
      expect((await store.findProgram(key))?.limit.minor).toBe(9_007_199_254_740_993n);
    });
  });
});
