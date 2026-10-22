import {
  type Kysely,
  type Migration,
  type MigrationProvider,
  type MigrationResultSet,
  Migrator,
} from 'kysely';
import * as m0001 from './migrations/0001_initial';

/**
 * Migrations are registered explicitly (not discovered from the filesystem) so the same code
 * works from ts-node, compiled dist/ and tests without path juggling.
 */
const migrations: Record<string, Migration> = {
  '0001_initial': m0001,
};

const provider: MigrationProvider = { getMigrations: () => Promise.resolve(migrations) };

/** Kysely migrator over the explicitly registered migrations. */
export function createMigrator<DB>(db: Kysely<DB>): Migrator {
  return new Migrator({ db, provider });
}

/**
 * Applies all pending migrations.
 * @throws the first migration error, so callers fail loudly.
 */
export async function migrateToLatest<DB>(db: Kysely<DB>): Promise<MigrationResultSet> {
  const result = await createMigrator(db).migrateToLatest();
  if (result.error) {
    throw result.error instanceof Error
      ? result.error
      : new Error('Migration failed', { cause: result.error });
  }
  return result;
}
