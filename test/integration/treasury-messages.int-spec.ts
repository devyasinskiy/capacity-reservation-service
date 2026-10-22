import { NO_METRICS } from '../../src/modules/capacity/application/ports/capacity-metrics';
import type { Kysely } from 'kysely';
import type { Database } from '../../src/shared/database/database.types';
import {
  ApplyTreasuryMessage,
  type MessageSource,
} from '../../src/modules/capacity/application/apply-treasury-message';
import { parseTreasuryMessage } from '../../src/modules/capacity/messaging/treasury-message.schema';
import { KyselyCapacityStore } from '../../src/modules/capacity/infrastructure/persistence/kysely-capacity-store';
import { auditLedger } from '../../src/modules/capacity/infrastructure/persistence/ledger-audit';
import { testDatabase, uniqueTenant } from '../support/db';
import { treasuryMessages } from '../support/treasury-messages';

describe('ApplyTreasuryMessage (integration)', () => {
  let db: Kysely<Database>;
  let store: KyselyCapacityStore;
  let apply: ApplyTreasuryMessage;
  let offset = 0;
  const source = (): MessageSource => ({
    topic: 'treasury.capacity.v1',
    partition: 0,
    offset: String(offset++),
  });

  beforeAll(() => {
    db = testDatabase({ poolMax: 10 });
    store = new KyselyCapacityStore(db, { lockTimeoutMs: 5000, statementTimeoutMs: 10000 });
    apply = new ApplyTreasuryMessage(store);
  });
  afterAll(() => db.destroy());

  function setup() {
    const key = { tenantId: uniqueTenant(), programId: 'PRG-T' };
    const msgs = treasuryMessages(key.tenantId, key.programId);
    const send = (raw: object, correlationId?: string) =>
      apply.execute(parseTreasuryMessage(JSON.stringify(raw)), source(), correlationId);
    const ledgerTypes = async () =>
      (
        await db
          .selectFrom('ledger_entries')
          .select('type')
          .where('tenant_id', '=', key.tenantId)
          .orderBy('id')
          .execute()
      ).map((r) => r.type);
    const expectConsistent = async () =>
      expect((await auditLedger(db, { tenantId: key.tenantId })).mismatches).toEqual([]);
    return { key, msgs, send, ledgerTypes, expectConsistent };
  }

  describe('PROGRAM_LIMIT_SET', () => {
    it('creates an unknown program with its opening ledger row and inbox entry, atomically', async () => {
      const t = setup();
      expect(await t.send(t.msgs.limitSet('1000000'), 'corr-k1')).toBe('APPLIED');
      const p = await store.findProgram(t.key);
      expect(p?.limit.minor).toBe(1_000_000n);
      expect(p?.toState().limitVersion).toBe(1n);
      const ledger = await db
        .selectFrom('ledger_entries')
        .selectAll()
        .where('tenant_id', '=', t.key.tenantId)
        .execute();
      expect(ledger).toMatchObject([
        { type: 'LIMIT_SET', source: 'KAFKA', correlation_id: 'corr-k1' },
      ]);
      const inbox = await db
        .selectFrom('inbox_messages')
        .selectAll()
        .where('tenant_id', '=', t.key.tenantId)
        .execute();
      expect(inbox).toMatchObject([{ outcome: 'APPLIED', type: 'PROGRAM_LIMIT_SET', version: 1n }]);
    });

    it('applies newer limits and records stale ones as STALE without changing state', async () => {
      const t = setup();
      await t.send(t.msgs.limitSet('1000', 'USD', { version: 5 }));
      expect(await t.send(t.msgs.limitSet('2000', 'USD', { version: 9 }))).toBe('APPLIED');
      expect(await t.send(t.msgs.limitSet('1', 'USD', { version: 7 }))).toBe('STALE');
      expect(await t.send(t.msgs.limitSet('1', 'USD', { version: 9 }))).toBe('STALE');
      expect((await store.findProgram(t.key))?.limit.minor).toBe(2000n);
      expect(await t.ledgerTypes()).toEqual(['LIMIT_SET', 'LIMIT_SET']);
      await t.expectConsistent();
    });

    it('ignores a redelivered message (same messageId) entirely', async () => {
      const t = setup();
      const raw = t.msgs.limitSet('1000');
      expect(await t.send(raw)).toBe('APPLIED');
      expect(await t.send(raw)).toBe('DUPLICATE');
      expect(await t.ledgerTypes()).toEqual(['LIMIT_SET']);
    });

    it('rejects a currency change (non-retryable domain error)', async () => {
      const t = setup();
      await t.send(t.msgs.limitSet('1000', 'USD'));
      await expect(t.send(t.msgs.limitSet('1000', 'EUR'))).rejects.toMatchObject({
        code: 'CURRENCY_MISMATCH',
      });
    });

    it('handles concurrent duplicate deliveries of the creating message: applied exactly once', async () => {
      const t = setup();
      const raw = t.msgs.limitSet('1000');
      const outcomes = await Promise.all(Array.from({ length: 8 }, () => t.send(raw)));
      expect(outcomes.filter((o) => o === 'APPLIED')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'DUPLICATE')).toHaveLength(7);
      expect(await t.ledgerTypes()).toEqual(['LIMIT_SET']);
    });
  });

  describe('external reservations', () => {
    it('reserves beyond the limit (treasury is authoritative) and flags over-limit', async () => {
      const t = setup();
      await t.send(t.msgs.limitSet('1000'));
      expect(await t.send(t.msgs.externalCreated('T-1', '1500'))).toBe('APPLIED');
      const p = await store.findProgram(t.key);
      expect(p?.reserved.minor).toBe(1500n);
      expect(p?.overLimit).toBe(true);
      await t.expectConsistent();
    });

    it('reports an over-limit transition once, after commit, when treasury pushes the program over (ADR-013)', async () => {
      const t = setup();
      const metrics = { ...NO_METRICS, overLimitTransition: jest.fn() };
      const instrumented = new ApplyTreasuryMessage(store, { metrics });
      const sendWith = (raw: object) =>
        instrumented.execute(parseTreasuryMessage(JSON.stringify(raw)), source());
      await sendWith(t.msgs.limitSet('1000'));
      await sendWith(t.msgs.externalCreated('T-1', '900'));
      expect(metrics.overLimitTransition).not.toHaveBeenCalled();
      await sendWith(t.msgs.externalCreated('T-2', '200')); // 1100 > 1000
      await sendWith(t.msgs.externalCreated('T-3', '50')); // already over: no new transition
      expect(metrics.overLimitTransition).toHaveBeenCalledTimes(1);
      expect(metrics.overLimitTransition).toHaveBeenCalledWith('EXTERNAL_RESERVATION');
      await sendWith(t.msgs.externalReleased('T-2', '200')); // back under
      await sendWith(t.msgs.limitSet('500')); // pushed over by a lower limit
      expect(metrics.overLimitTransition).toHaveBeenLastCalledWith('LIMIT_SET');
    });

    it('is idempotent by externalRef when re-sent under a new messageId, and conflicts on different facts', async () => {
      const t = setup();
      await t.send(t.msgs.limitSet('10000'));
      await t.send(t.msgs.externalCreated('T-1', '500'));
      expect(await t.send(t.msgs.externalCreated('T-1', '500'))).toBe('ALREADY_APPLIED');
      await expect(t.send(t.msgs.externalCreated('T-1', '600'))).rejects.toMatchObject({
        code: 'RESERVATION_CONFLICT',
      });
      expect((await store.findProgram(t.key))?.reserved.minor).toBe(500n);
    });

    it('releases partially, then the rest; over-release and unknown refs are rejected', async () => {
      const t = setup();
      await t.send(t.msgs.limitSet('10000'));
      await t.send(t.msgs.externalCreated('T-1', '500'));
      expect(await t.send(t.msgs.externalReleased('T-1', '200'))).toBe('APPLIED');
      await expect(t.send(t.msgs.externalReleased('T-1', '301'))).rejects.toMatchObject({
        code: 'OVER_RELEASE',
      });
      expect(await t.send(t.msgs.externalReleased('T-1', '300'))).toBe('APPLIED');
      await expect(t.send(t.msgs.externalReleased('T-404', '1'))).rejects.toMatchObject({
        code: 'RESERVATION_NOT_FOUND',
      });
      expect((await store.findProgram(t.key))?.reserved.minor).toBe(0n);
      expect(await t.ledgerTypes()).toEqual([
        'LIMIT_SET',
        'EXTERNAL_RESERVE',
        'EXTERNAL_RELEASE',
        'EXTERNAL_RELEASE',
      ]);
      await t.expectConsistent();
    });

    it('rejects external amounts in a non-program currency', async () => {
      const t = setup();
      await t.send(t.msgs.limitSet('10000'));
      await expect(
        t.send(t.msgs.externalCreated('T-1', '5', { currency: 'EUR' })),
      ).rejects.toMatchObject({
        code: 'CURRENCY_MISMATCH',
      });
    });

    it('fails for programs that do not exist yet', async () => {
      const t = setup();
      await expect(t.send(t.msgs.externalCreated('T-1', '5'))).rejects.toMatchObject({
        code: 'PROGRAM_NOT_FOUND',
      });
    });

    it('applies delta messages regardless of version (they are idempotent by ref, not watermarked)', async () => {
      const t = setup();
      await t.send(t.msgs.limitSet('10000', 'USD', { version: 50 }));
      expect(await t.send(t.msgs.externalCreated('T-1', '5', { version: 3 }))).toBe('APPLIED');
    });
  });
});
