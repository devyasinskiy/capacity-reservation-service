import { sql } from 'kysely';
import { testDatabase } from '../support/db';
import { signal } from '../support/locks';

describe('database pool resilience (integration)', () => {
  it('survives the server terminating an idle pooled connection and reconnects', async () => {
    const errors: Error[] = [];
    const appName = `resilience-${Date.now()}`;
    const db = testDatabase({
      poolMax: 1,
      applicationName: appName,
      onPoolError: (e) => errors.push(e),
    });
    const admin = testDatabase({ poolMax: 1 });
    try {
      await sql`select 1`.execute(db); // leaves one idle client in the pool

      // Simulates a DB restart/failover for this pool's connection only.
      await sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = ${appName}`.execute(
        admin,
      );
      await new Promise((r) => setTimeout(r, 200));

      expect(errors.length).toBeGreaterThan(0); // handled, not an unhandled 'error' crash
      const res = await sql<{ ok: number }>`select 1 as ok`.execute(db);
      expect(res.rows[0]?.ok).toBe(1);
    } finally {
      await db.destroy();
      await admin.destroy();
    }
  });
});

describe('pool acquire timeout (integration)', () => {
  it('fails fast with a retryable error instead of queueing forever when the pool is exhausted', async () => {
    const { KyselyCapacityStore } =
      await import('../../src/modules/capacity/infrastructure/persistence/kysely-capacity-store');
    const { RetryableError } = await import('../../src/shared/errors/retryable-error');
    const db = testDatabase({ poolMax: 1, acquireTimeoutMs: 200 });
    const store = new KyselyCapacityStore(db, { lockTimeoutMs: 2000, statementTimeoutMs: 5000 });
    try {
      const holding = signal();
      const done = signal();
      const hog = db.transaction().execute(async () => {
        holding.fire();
        await done.promise;
      });
      await holding.promise; // the only pooled connection is now checked out
      const started = Date.now();
      const err = await store
        .findProgram({ tenantId: 'x', programId: 'y' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RetryableError);
      expect(Date.now() - started).toBeLessThan(1000);
      done.fire();
      await hog;
    } finally {
      await db.destroy();
    }
  });
});
