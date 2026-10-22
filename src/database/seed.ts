import type { Kysely } from 'kysely';
import type { Database } from '../shared/database/database.types';
import { Money } from '../shared/money/money';
import { Program } from '../modules/capacity/domain/program';
import { KyselyCapacityStore } from '../modules/capacity/infrastructure/persistence/kysely-capacity-store';

/**
 * Demo programs, created through the domain + store so the ledger explains every balance from
 * row one. Idempotent: existing programs are left untouched. t-2 exists to demo tenant isolation.
 */
export const SEED_PROGRAMS = [
  { tenantId: 't-1', programId: 'PRG-USD-001', currency: 'USD', limitMinor: 1_000_000_000n }, // $10,000,000.00
  { tenantId: 't-1', programId: 'PRG-EUR-001', currency: 'EUR', limitMinor: 500_000_000n }, // €5,000,000.00
  { tenantId: 't-1', programId: 'PRG-JPY-001', currency: 'JPY', limitMinor: 1_000_000_000n }, // ¥1,000,000,000
  { tenantId: 't-2', programId: 'PRG-USD-001', currency: 'USD', limitMinor: 250_000_000n }, // $2,500,000.00
] as const;

/**
 * Creates the demo programs (idempotent).
 * @returns one human-readable status line per program.
 */
export async function seed(db: Kysely<Database>): Promise<string[]> {
  const store = new KyselyCapacityStore(db, { lockTimeoutMs: 2000, statementTimeoutMs: 5000 });
  const out: string[] = [];
  for (const p of SEED_PROGRAMS) {
    const { program, movement } = Program.open({
      tenantId: p.tenantId,
      programId: p.programId,
      limit: Money.of(p.limitMinor, p.currency),
      version: 0n,
    });
    const created = await store.createProgram(program, movement, {
      source: 'SYSTEM',
      sourceRef: 'seed',
    });
    out.push(
      `${created ? 'created' : 'exists '}: ${p.tenantId}/${p.programId} ${p.currency} ${p.limitMinor} (minor)`,
    );
  }
  return out;
}
