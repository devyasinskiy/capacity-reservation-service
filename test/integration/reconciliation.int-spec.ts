import { type Kysely, sql } from 'kysely';
import type { Database } from '../../src/shared/database/database.types';
import { Money } from '../../src/shared/money/money';
import {
  ApplyTreasuryMessage,
  type MessageSource,
} from '../../src/modules/capacity/application/apply-treasury-message';
import { ReleaseReservation } from '../../src/modules/capacity/application/release-reservation';
import { ReserveCapacity } from '../../src/modules/capacity/application/reserve-capacity';
import { parseTreasuryMessage } from '../../src/modules/capacity/messaging/treasury-message.schema';
import { StubFxRateProvider } from '../../src/modules/capacity/infrastructure/fx/stub-fx-rate-provider';
import { KyselyCapacityStore } from '../../src/modules/capacity/infrastructure/persistence/kysely-capacity-store';
import { auditLedger } from '../../src/modules/capacity/infrastructure/persistence/ledger-audit';
import { testDatabase, uniqueTenant } from '../support/db';
import { type SnapshotRow, treasuryMessages } from '../support/treasury-messages';

const FIVE_MIN = 5 * 60_000;

describe('reconciliation snapshots (integration, ADR-011/020)', () => {
  let db: Kysely<Database>;
  let store: KyselyCapacityStore;
  let offset = 0;
  const clock = { now: () => new Date() };
  const source = (): MessageSource => ({ topic: 't', partition: 0, offset: String(offset++) });

  beforeAll(() => {
    db = testDatabase({ poolMax: 10 });
    store = new KyselyCapacityStore(db, { lockTimeoutMs: 5000, statementTimeoutMs: 10000 });
  });
  afterAll(() => db.destroy());

  /** DB clock: ledger timestamps are DB time, so asOf must be too (ADR-008). */
  const dbNow = async () =>
    (await sql<{ t: Date }>`select clock_timestamp() as t`.execute(db)).rows[0]!.t;

  async function setup(graceWindowMs = 0) {
    const key = { tenantId: uniqueTenant(), programId: 'PRG-R' };
    const msgs = treasuryMessages(key.tenantId, key.programId);
    const apply = new ApplyTreasuryMessage(store, { graceWindowMs });
    const send = (raw: object) =>
      apply.execute(parseTreasuryMessage(JSON.stringify(raw)), source(), 'corr-recon');
    await send(msgs.limitSet('1000000'));
    const reserve = new ReserveCapacity(store, new StubFxRateProvider(clock), clock, 60_000);
    const release = new ReleaseReservation(store);
    const local = async (invoiceId: string, minor: bigint) =>
      (await reserve.execute({ program: key, invoiceId, amount: Money.of(minor, 'USD') })).body;
    const row = (
      ref: string,
      outstanding: bigint | string,
      origin: SnapshotRow['origin'] = 'LOCAL',
      invoiceId = `INV-${ref}`,
    ): SnapshotRow => ({
      origin,
      ref,
      invoiceId,
      outstandingMinor: String(outstanding),
    });
    const runs = () =>
      db
        .selectFrom('reconciliation_runs')
        .selectAll()
        .where('tenant_id', '=', key.tenantId)
        .orderBy('applied_at')
        .execute();
    const discrepancies = () =>
      db
        .selectFrom('reconciliation_discrepancies')
        .selectAll()
        .where('tenant_id', '=', key.tenantId)
        .orderBy('detected_at')
        .execute();
    const staged = async () =>
      Number(
        (
          await db
            .selectFrom('snapshot_parts')
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .where('tenant_id', '=', key.tenantId)
            .executeTakeFirstOrThrow()
        ).n,
      );
    return { key, msgs, send, local, release, row, runs, discrepancies, staged };
  }

  describe('single-part snapshots', () => {
    it('matching snapshot: applies the newer limit, records a clean run, drops staged parts', async () => {
      const t = await setup();
      const r = await t.local('INV-1', 500n);
      const [part] = t.msgs.snapshot({
        asOf: await dbNow(),
        limitMinor: '2000000',
        reservations: [t.row(r.id, 500n, 'LOCAL', 'INV-1')],
      });
      expect(await t.send(part!)).toBe('APPLIED');

      const [run] = await t.runs();
      expect(run).toMatchObject({
        limit_applied: true,
        discrepancy_count: 0,
        uncertain_count: 0,
        treasury_total_minor: 500n,
        local_total_minor: 500n,
        correlation_id: 'corr-recon',
      });
      expect(await t.discrepancies()).toEqual([]);
      expect(await t.staged()).toBe(0);
      expect((await store.findProgram(t.key))?.limit.minor).toBe(2_000_000n);
      expect((await auditLedger(db, { tenantId: t.key.tenantId })).mismatches).toEqual([]);
    });

    it('keeps local reservations created after asOf untouched and unflagged', async () => {
      const t = await setup();
      const asOf = await dbNow();
      const r = await t.local('INV-LATE', 700n); // after asOf: treasury cannot know it yet
      const [part] = t.msgs.snapshot({ asOf, limitMinor: '1000000', reservations: [] });
      await t.send(part!);

      expect(await t.discrepancies()).toEqual([]);
      expect((await store.findProgram(t.key))?.reserved.minor).toBe(700n);
      const kept = await db
        .selectFrom('reservations')
        .select('status')
        .where('id', '=', r.id)
        .executeTakeFirstOrThrow();
      expect(kept.status).toBe('ACTIVE');
    });

    it('missing in treasury once → PENDING; missing again in the next snapshot → OPEN (flagged), never deleted', async () => {
      const t = await setup();
      const r = await t.local('INV-1', 300n);
      await t.send(
        t.msgs.snapshot({ asOf: await dbNow(), limitMinor: '1000000', reservations: [] })[0]!,
      );
      expect(await t.discrepancies()).toMatchObject([
        {
          kind: 'MISSING_IN_TREASURY',
          reservation_ref: r.id,
          status: 'PENDING',
          strikes: 1,
          local_outstanding_minor: 300n,
        },
      ]);

      await t.send(
        t.msgs.snapshot({ asOf: await dbNow(), limitMinor: '1000000', reservations: [] })[0]!,
      );
      const [d] = await t.discrepancies();
      expect(d).toMatchObject({ status: 'OPEN', strikes: 2 });
      expect(d!.first_run_id).not.toBe(d!.last_run_id);
      expect((await store.findProgram(t.key))?.reserved.minor).toBe(300n); // flag, never fix
    });

    it('a pending discrepancy that the next snapshot no longer reproduces is CLEARED', async () => {
      const t = await setup();
      const r = await t.local('INV-1', 300n);
      await t.send(
        t.msgs.snapshot({ asOf: await dbNow(), limitMinor: '1000000', reservations: [] })[0]!,
      );
      await t.send(
        t.msgs.snapshot({
          asOf: await dbNow(),
          limitMinor: '1000000',
          reservations: [t.row(r.id, 300n, 'LOCAL', 'INV-1')],
        })[0]!,
      );
      expect(await t.discrepancies()).toMatchObject([{ status: 'CLEARED', strikes: 1 }]);
    });

    it('a reservation just before asOf (inside the grace window) is UNCERTAIN, not a strike', async () => {
      const t = await setup(FIVE_MIN);
      await t.local('INV-1', 300n);
      await t.send(
        t.msgs.snapshot({ asOf: await dbNow(), limitMinor: '1000000', reservations: [] })[0]!,
      );
      expect(await t.discrepancies()).toEqual([]);
      expect((await t.runs())[0]).toMatchObject({ uncertain_count: 1, discrepancy_count: 0 });
    });

    it('flags a partial release treasury has not reflected as AMOUNT_MISMATCH', async () => {
      const t = await setup();
      const r = await t.local('INV-1', 1000n);
      await t.release.execute({
        program: t.key,
        reservationId: r.id,
        amount: Money.of(400n, 'USD'),
        idempotencyKey: 'k',
      });
      await t.send(
        t.msgs.snapshot({
          asOf: await dbNow(),
          limitMinor: '1000000',
          reservations: [t.row(r.id, 1000n, 'LOCAL', 'INV-1')],
        })[0]!,
      );
      expect(await t.discrepancies()).toMatchObject([
        {
          kind: 'AMOUNT_MISMATCH',
          local_outstanding_minor: 600n,
          treasury_outstanding_minor: 1000n,
        },
      ]);
    });

    it('flags treasury reservations we never received as MISSING_LOCALLY (and does not create them)', async () => {
      const t = await setup();
      await t.send(
        t.msgs.snapshot({
          asOf: await dbNow(),
          limitMinor: '1000000',
          reservations: [t.row('T-404', 250n, 'EXTERNAL')],
        })[0]!,
      );
      expect(await t.discrepancies()).toMatchObject([
        {
          kind: 'MISSING_LOCALLY',
          origin: 'EXTERNAL',
          reservation_ref: 'T-404',
          treasury_outstanding_minor: 250n,
        },
      ]);
      expect((await store.findProgram(t.key))?.reserved.minor).toBe(0n);
    });

    it('records a stale snapshot (version ≤ last applied) as STALE', async () => {
      const t = await setup();
      const asOf = await dbNow();
      await t.send(t.msgs.snapshot({ asOf, limitMinor: '1', reservations: [], version: 10 })[0]!);
      expect(
        await t.send(t.msgs.snapshot({ asOf, limitMinor: '2', reservations: [], version: 9 })[0]!),
      ).toBe('STALE');
      expect(await t.runs()).toHaveLength(1);
    });

    it('an older snapshot completing after a newer LIMIT_SET does not roll the limit back', async () => {
      const t = await setup();
      const parts = t.msgs.snapshot({
        asOf: await dbNow(),
        limitMinor: '111',
        reservations: [],
        totalParts: 2,
        version: 10,
      });
      await t.send(parts[0]!);
      await t.send(t.msgs.limitSet('999999', 'USD', { version: 11 }));
      expect(await t.send(parts[1]!)).toBe('APPLIED');
      expect((await store.findProgram(t.key))?.limit.minor).toBe(999_999n);
      expect((await t.runs())[0]).toMatchObject({ limit_applied: false });
    });
  });

  describe('chunked snapshots (ADR-020)', () => {
    it('applies once all parts arrive, in any order; duplicates are no-ops', async () => {
      const t = await setup();
      const a = await t.local('INV-A', 100n);
      const b = await t.local('INV-B', 200n);
      const c = await t.local('INV-C', 300n);
      const parts = t.msgs.snapshot({
        asOf: await dbNow(),
        limitMinor: '1000000',
        totalParts: 3,
        reservations: [
          t.row(a.id, 100n, 'LOCAL', 'INV-A'),
          t.row(b.id, 200n, 'LOCAL', 'INV-B'),
          t.row(c.id, 300n, 'LOCAL', 'INV-C'),
        ],
      });
      expect(await t.send(parts[2]!)).toBe('STAGED');
      expect(await t.send(parts[0]!)).toBe('STAGED');
      expect(await t.send({ ...parts[0]!, messageId: 'resent-part-1' })).toBe('ALREADY_APPLIED');
      expect(await t.runs()).toHaveLength(0);
      expect(await t.send(parts[1]!)).toBe('APPLIED');
      expect(await t.runs()).toMatchObject([{ treasury_total_minor: 600n, discrepancy_count: 0 }]);
      expect(await t.staged()).toBe(0);
    });

    it('does not apply while a part is missing', async () => {
      const t = await setup();
      const parts = t.msgs.snapshot({
        asOf: await dbNow(),
        limitMinor: '5',
        reservations: [],
        totalParts: 3,
      });
      await t.send(parts[0]!);
      await t.send(parts[2]!);
      expect(await t.runs()).toHaveLength(0);
      expect(await t.staged()).toBe(2);
      expect((await store.findProgram(t.key))?.limit.minor).toBe(1_000_000n);
    });

    it('a newer snapshot version supersedes an incomplete older one; late parts of the older are STALE', async () => {
      const t = await setup();
      const asOf = await dbNow();
      const old = t.msgs.snapshot({
        asOf,
        limitMinor: '1',
        reservations: [],
        totalParts: 2,
        version: 20,
      });
      const fresh = t.msgs.snapshot({
        asOf,
        limitMinor: '2',
        reservations: [],
        totalParts: 2,
        version: 21,
      });
      await t.send(old[0]!);
      await t.send(fresh[0]!);
      expect(await t.staged()).toBe(1); // old part discarded
      expect(await t.send(old[1]!)).toBe('STALE');
      expect(await t.send(fresh[1]!)).toBe('APPLIED');
      expect((await store.findProgram(t.key))?.limit.minor).toBe(2n);
    });

    it('rejects parts whose headers disagree, discarding the set (dead-lettered)', async () => {
      const t = await setup();
      const parts = t.msgs.snapshot({
        asOf: await dbNow(),
        limitMinor: '10',
        reservations: [],
        totalParts: 2,
      });
      await t.send(parts[0]!);
      const tampered = {
        ...parts[1]!,
        payload: { ...parts[1]!.payload, limitMinor: '11' },
      };
      await expect(t.send(tampered)).rejects.toMatchObject({ code: 'SNAPSHOT_INCONSISTENT' });
      expect(await t.staged()).toBe(0);
    });

    it('is crash-safe: if reconciliation fails after the last part is staged, redelivery completes it', async () => {
      const t = await setup();
      const parts = t.msgs.snapshot({
        asOf: await dbNow(),
        limitMinor: '42',
        reservations: [],
        totalParts: 2,
      });
      await t.send(parts[0]!);

      const original = store.localStateAsOf.bind(store);
      const spy = jest
        .spyOn(store, 'localStateAsOf')
        .mockRejectedValueOnce(new Error('crash mid-reconcile'));
      await expect(t.send(parts[1]!)).rejects.toThrow('crash mid-reconcile');
      expect(await t.runs()).toHaveLength(0);
      expect(await t.staged()).toBe(2); // last part staged, but its inbox entry was not written

      spy.mockImplementation(original);
      expect(await t.send(parts[1]!)).toBe('APPLIED'); // redelivery
      expect(await t.send(parts[1]!)).toBe('DUPLICATE');
      expect((await store.findProgram(t.key))?.limit.minor).toBe(42n);
      spy.mockRestore();
    });

    it('expired incomplete parts are purged by the TTL sweep', async () => {
      const t = await setup();
      await t.send(
        t.msgs.snapshot({
          asOf: await dbNow(),
          limitMinor: '5',
          reservations: [],
          totalParts: 2,
        })[0]!,
      );
      expect(await t.staged()).toBe(1);
      await store.purgeStagedSnapshotParts(new Date(Date.now() + 60_000));
      expect(await t.staged()).toBe(0);
    });
  });
});
