import type { Kysely } from 'kysely';
import { DomainError } from '../../src/shared/errors/domain-error';
import type { Database } from '../../src/shared/database/database.types';
import { Money } from '../../src/shared/money/money';
import type { ProgramKey } from '../../src/modules/capacity/application/ports/capacity-store';
import { ReleaseReservation } from '../../src/modules/capacity/application/release-reservation';
import { ReserveCapacity } from '../../src/modules/capacity/application/reserve-capacity';
import { Program } from '../../src/modules/capacity/domain/program';
import { StubFxRateProvider } from '../../src/modules/capacity/infrastructure/fx/stub-fx-rate-provider';
import { KyselyCapacityStore } from '../../src/modules/capacity/infrastructure/persistence/kysely-capacity-store';
import { auditLedger } from '../../src/modules/capacity/infrastructure/persistence/ledger-audit';
import { testDatabase, uniqueTenant } from '../support/db';

/** Seeded Fisher–Yates so failures are reproducible. */
function shuffle<T>(items: T[], seed: number): void {
  let state = seed;
  const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
}

/**
 * Proves ADR-005: concurrent writers on one program can never over-reserve, and the stored
 * balance always equals the ledger. Runs against real Postgres with a 20-connection pool, so up
 * to 20 transactions genuinely contend for the program row lock at any moment.
 */
describe('concurrency guarantees (integration)', () => {
  let db: Kysely<Database>;
  let store: KyselyCapacityStore;
  let reserve: ReserveCapacity;
  let release: ReleaseReservation;
  const clock = { now: () => new Date() };

  beforeAll(() => {
    db = testDatabase({ poolMax: 20 });
    // Generous lock timeout: this suite measures correctness, not shedding (see the 503 e2e test).
    store = new KyselyCapacityStore(db, { lockTimeoutMs: 15_000, statementTimeoutMs: 30_000 });
    reserve = new ReserveCapacity(store, new StubFxRateProvider(clock), clock, 60_000);
    release = new ReleaseReservation(store);
  });
  afterAll(() => db.destroy());

  async function program(limitMinor: bigint, currency = 'USD'): Promise<ProgramKey> {
    const key = { tenantId: uniqueTenant(), programId: 'PRG-HOT' };
    const { program: p, movement } = Program.open({
      ...key,
      limit: Money.of(limitMinor, currency),
      version: 1n,
    });
    await store.createProgram(p, movement, { source: 'SYSTEM' });
    return key;
  }

  const settle = async <T>(tasks: Array<() => Promise<T>>) =>
    Promise.allSettled(tasks.map((t) => t()));
  const codeOf = (r: PromiseSettledResult<unknown>) =>
    r.status === 'fulfilled'
      ? 'OK'
      : r.reason instanceof DomainError
        ? r.reason.code
        : String(r.reason);

  async function expectLedgerConsistent(key: ProgramKey) {
    const audit = await auditLedger(db, { tenantId: key.tenantId });
    expect(audit.mismatches).toEqual([]);
    expect(audit.programsChecked).toBe(1);
  }

  it('200 parallel reservations for a limit that fits exactly 50 → exactly 50 succeed', async () => {
    const key = await program(5_000n);
    const results = await settle(
      Array.from(
        { length: 200 },
        (_, i) => () =>
          reserve.execute({ program: key, invoiceId: `INV-${i}`, amount: Money.of(100n, 'USD') }),
      ),
    );
    const codes = results.map(codeOf);
    expect(codes.filter((c) => c === 'OK')).toHaveLength(50);
    expect(codes.filter((c) => c === 'INSUFFICIENT_CAPACITY')).toHaveLength(150);

    const p = await store.findProgram(key);
    expect(p?.reserved.minor).toBe(5_000n);
    expect(p?.available.minor).toBe(0n);
    await expectLedgerConsistent(key);
  });

  it('random amounts in mixed currencies never exceed the limit (sum of accepted ≤ limit)', async () => {
    const key = await program(1_000_000n);
    const currencies = ['USD', 'EUR', 'GBP', 'JPY', 'KWD'];
    const results = await settle(
      Array.from(
        { length: 300 },
        (_, i) => () =>
          reserve.execute({
            program: key,
            invoiceId: `INV-${i}`,
            amount: Money.of(
              BigInt(1_000 + ((i * 7919) % 9_000)),
              currencies[i % currencies.length]!,
            ),
          }),
      ),
    );
    const accepted = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.body] : []));
    expect(results.map(codeOf).every((c) => c === 'OK' || c === 'INSUFFICIENT_CAPACITY')).toBe(
      true,
    );
    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted.length).toBeLessThan(300); // the limit actually binds

    const sum = accepted.reduce((acc, r) => acc + BigInt(r.programAmount.amountMinor), 0n);
    const p = await store.findProgram(key);
    expect(sum <= 1_000_000n).toBe(true);
    expect(p?.reserved.minor).toBe(sum);
    await expectLedgerConsistent(key);
  });

  it('50 parallel retries of the same invoice create exactly one reservation', async () => {
    const key = await program(1_000_000n);
    const results = await settle(
      Array.from(
        { length: 50 },
        () => () =>
          reserve.execute({ program: key, invoiceId: 'INV-SAME', amount: Money.of(1_234n, 'EUR') }),
      ),
    );
    const ok = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    expect(ok).toHaveLength(50);
    expect(new Set(ok.map((r) => r.body.id)).size).toBe(1);
    expect(ok.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await store.findProgram(key))?.reserved.minor).toBe(1_336n); // ceil(12.34 × 1.0825 × 100)
    await expectLedgerConsistent(key);
  });

  it('20 parallel releases with the same Idempotency-Key release once', async () => {
    const key = await program(1_000_000n);
    const { body: r } = await reserve.execute({
      program: key,
      invoiceId: 'INV-1',
      amount: Money.of(10_000n, 'USD'),
    });
    const results = await settle(
      Array.from(
        { length: 20 },
        () => () =>
          release.execute({
            program: key,
            reservationId: r.id,
            amount: Money.of(2_500n, 'USD'),
            idempotencyKey: 'rel-once',
          }),
      ),
    );
    expect(results.map(codeOf).every((c) => c === 'OK')).toBe(true);
    expect((await store.findProgram(key))?.reserved.minor).toBe(7_500n);
    await expectLedgerConsistent(key);
  });

  it('a storm of reserves and partial releases keeps reserved = Σ outstanding = Σ ledger', async () => {
    const key = await program(200_000n);
    const seeded = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        reserve.execute({ program: key, invoiceId: `SEED-${i}`, amount: Money.of(3_001n, 'EUR') }),
      ),
    );
    const tasks: Array<() => Promise<unknown>> = [];
    seeded.forEach(({ body }, i) => {
      // three partial releases of 1000 EUR-minor each, then the remainder (1 minor) — interleaved
      for (let k = 0; k < 3; k++) {
        tasks.push(() =>
          release.execute({
            program: key,
            reservationId: body.id,
            amount: Money.of(1_000n, 'EUR'),
            idempotencyKey: `r-${i}-${k}`,
          }),
        );
      }
      tasks.push(() =>
        release.execute({ program: key, reservationId: body.id, idempotencyKey: `r-${i}-rest` }),
      );
    });
    for (let i = 0; i < 150; i++) {
      tasks.push(() =>
        reserve.execute({ program: key, invoiceId: `NEW-${i}`, amount: Money.of(1_500n, 'USD') }),
      );
    }
    shuffle(tasks, 42); // deterministic interleaving of releases and reserves

    const results = await settle(tasks);
    const unexpected = results
      .map(codeOf)
      .filter(
        (c) =>
          !['OK', 'INSUFFICIENT_CAPACITY', 'OVER_RELEASE', 'RESERVATION_ALREADY_RELEASED'].includes(
            c,
          ),
      );
    expect(unexpected).toEqual([]);

    const outstanding = await db
      .selectFrom('reservations')
      .select((eb) =>
        eb.fn
          .sum<string>(eb('program_amount_minor', '-', eb.ref('released_program_minor')))
          .as('s'),
      )
      .where('tenant_id', '=', key.tenantId)
      .executeTakeFirstOrThrow();
    const p = await store.findProgram(key);
    expect(p?.reserved.minor).toBe(BigInt(outstanding.s));
    expect(p!.reserved.minor <= 200_000n).toBe(true);
    await expectLedgerConsistent(key);
  });

  it('the ledger audit actually detects drift (guards against a vacuous check)', async () => {
    const key = await program(10_000n);
    const { body: r } = await reserve.execute({
      program: key,
      invoiceId: 'INV-1',
      amount: Money.of(500n, 'USD'),
    });
    // Simulate a bug that bypasses the domain: bump the balance and a reservation without ledger rows.
    await db
      .updateTable('programs')
      .set({ reserved_minor: 501n, limit_minor: 9_999n })
      .where('tenant_id', '=', key.tenantId)
      .execute();
    await db
      .updateTable('reservations')
      .set({ released_program_minor: 100n })
      .where('id', '=', r.id)
      .execute();

    const { mismatches } = await auditLedger(db, { tenantId: key.tenantId });
    expect(mismatches.map((m) => m.kind).sort()).toEqual([
      'PROGRAM_LIMIT',
      'PROGRAM_RESERVED',
      'RESERVATION_OUTSTANDING',
    ]);
    expect(mismatches.find((m) => m.kind === 'PROGRAM_RESERVED')).toMatchObject({
      stored: '501',
      fromLedger: '500',
    });
  });

  it('measures single-program write throughput (indicative; recorded in ADR-005)', async () => {
    const key = await program(10n ** 15n);
    const n = 1000;
    const latencies: number[] = [];
    const started = performance.now();
    await Promise.all(
      Array.from({ length: n }, async (_, i) => {
        const t0 = performance.now();
        await reserve.execute({
          program: key,
          invoiceId: `PERF-${i}`,
          amount: Money.of(100n, 'USD'),
        });
        latencies.push(performance.now() - t0);
      }),
    );
    const seconds = (performance.now() - started) / 1000;
    latencies.sort((a, b) => a - b);
    const pct = (p: number) =>
      latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]!.toFixed(
        0,
      );
    const opsPerSec = n / seconds;
    console.log(
      `[throughput] ${n} reservations on ONE program, pool=20: ${opsPerSec.toFixed(0)} ops/s ` +
        `(wall ${seconds.toFixed(2)}s; client latency p50=${pct(50)}ms p95=${pct(95)}ms p99=${pct(99)}ms incl. queueing)`,
    );
    expect(opsPerSec).toBeGreaterThan(50); // sanity floor only; CI machines vary
    await expectLedgerConsistent(key);
  });
});
