/**
 * Database CLI: `node dist/database/cli.js <migrate|rollback|seed|verify-ledger>` (or `npm run db:*`).
 * Run by the compose `migrate` service before the app starts.
 */
import { auditLedger } from '../modules/capacity/infrastructure/persistence/ledger-audit';
import { createDatabase } from '../shared/database/database';
import { createMigrator, migrateToLatest } from './migrator';
import { seed } from './seed';

async function main(): Promise<void> {
  const command = process.argv[2];
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const db = createDatabase(url, { poolMax: 2, applicationName: 'capacity-cli' });
  try {
    switch (command) {
      case 'migrate': {
        const { results } = await migrateToLatest(db);
        for (const r of results ?? []) console.log(`${r.status}: ${r.migrationName}`);
        if (!results?.length) console.log('Already up to date');
        break;
      }
      case 'rollback': {
        const { error, results } = await createMigrator(db).migrateDown();
        for (const r of results ?? []) console.log(`${r.status}: ${r.migrationName} (down)`);
        if (error) {
          throw error instanceof Error ? error : new Error('Rollback failed', { cause: error });
        }
        break;
      }
      case 'seed':
        for (const line of await seed(db)) console.log(line);
        break;
      case 'verify-ledger': {
        const { programsChecked, mismatches } = await auditLedger(db);
        console.log(`Checked ${programsChecked} programs: ${mismatches.length} mismatch(es)`);
        for (const m of mismatches) console.log(JSON.stringify(m));
        if (mismatches.length > 0) process.exitCode = 2;
        break;
      }
      default:
        throw new Error(
          `Unknown command "${command}". Use migrate | rollback | seed | verify-ledger.`,
        );
    }
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
