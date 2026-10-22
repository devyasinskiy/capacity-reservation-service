import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createMigrator, migrateToLatest } from '../../src/database/migrator';
import { seed } from '../../src/database/seed';
import { createDatabase } from '../../src/shared/database/database';
import { testDatabase } from '../support/db';

describe('migrations and seed (integration)', () => {
  it('migrate → rollback → migrate round-trips on a fresh database', async () => {
    const admin = testDatabase();
    const name = `migr_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await sql`create database ${sql.id(name)}`.execute(admin);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${name}`;
    const db = createDatabase(url.toString(), { poolMax: 1 });
    try {
      const tables = async () =>
        (
          await sql<{
            n: number;
          }>`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name not like 'kysely_%'`.execute(
            db,
          )
        ).rows[0]!.n;

      await migrateToLatest(db);
      expect(await tables()).toBe(8);
      const down = await createMigrator(db).migrateDown();
      expect(down.error).toBeUndefined();
      expect(await tables()).toBe(0);
      await migrateToLatest(db);
      expect(await tables()).toBe(8);
    } finally {
      await db.destroy();
      await sql`drop database ${sql.id(name)} with (force)`.execute(admin);
      await admin.destroy();
    }
  });

  it('seed is idempotent', async () => {
    const db = testDatabase();
    try {
      const first = await seed(db);
      const second = await seed(db);
      expect(second.every((l) => l.startsWith('exists'))).toBe(true);
      expect(first).toHaveLength(second.length);
    } finally {
      await db.destroy();
    }
  });
});
