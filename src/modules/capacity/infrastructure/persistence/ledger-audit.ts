import { type Kysely, sql } from 'kysely';
import type { Database } from '../../../../shared/database/database.types';

/** A stored balance that the ledger does not explain. */
export interface LedgerMismatch {
  readonly kind: 'PROGRAM_RESERVED' | 'PROGRAM_LIMIT' | 'RESERVATION_OUTSTANDING';
  readonly tenantId: string;
  readonly programId: string;
  readonly reservationId?: string;
  readonly stored: string;
  readonly fromLedger: string;
}

/** Outcome of {@link auditLedger}; `mismatches` is empty when the ledger explains every balance. */
export interface LedgerAuditResult {
  readonly programsChecked: number;
  readonly mismatches: readonly LedgerMismatch[];
}

/**
 * Replays the ledger and compares it with stored state (ADR-008). Invariants:
 *  - programs.reserved_minor = Σ reserved_delta_minor
 *  - programs.limit_minor   = limit_after_minor of the latest ledger row
 *  - per reservation: Σ its deltas = program_amount − released_program (its outstanding amount)
 * Read-only; safe to run in production (CLI `verify-ledger`) and used by the concurrency tests.
 */
export async function auditLedger(
  db: Kysely<Database>,
  filter: { tenantId?: string } = {},
): Promise<LedgerAuditResult> {
  const tenant = filter.tenantId ?? null;

  const programs = await sql<{
    tenant_id: string;
    program_id: string;
    reserved_minor: bigint;
    limit_minor: bigint;
    ledger_reserved: bigint;
    ledger_limit: bigint | null;
  }>`
    select p.tenant_id, p.program_id, p.reserved_minor, p.limit_minor,
           coalesce(sum(l.reserved_delta_minor), 0)::bigint as ledger_reserved,
           (select l2.limit_after_minor from ledger_entries l2
             where l2.tenant_id = p.tenant_id and l2.program_id = p.program_id
             order by l2.id desc limit 1) as ledger_limit
      from programs p
      left join ledger_entries l on l.tenant_id = p.tenant_id and l.program_id = p.program_id
     where (${tenant}::text is null or p.tenant_id = ${tenant})
     group by p.tenant_id, p.program_id
  `.execute(db);

  const reservations = await sql<{
    tenant_id: string;
    program_id: string;
    id: string;
    outstanding: bigint;
    ledger_outstanding: bigint;
  }>`
    select r.tenant_id, r.program_id, r.id,
           (r.program_amount_minor - r.released_program_minor)::bigint as outstanding,
           coalesce(sum(l.reserved_delta_minor), 0)::bigint as ledger_outstanding
      from reservations r
      left join ledger_entries l on l.reservation_id = r.id
     where (${tenant}::text is null or r.tenant_id = ${tenant})
     group by r.id
    having (r.program_amount_minor - r.released_program_minor) <> coalesce(sum(l.reserved_delta_minor), 0)
  `.execute(db);

  const mismatches: LedgerMismatch[] = [];
  for (const p of programs.rows) {
    const base = { tenantId: p.tenant_id, programId: p.program_id };
    if (p.reserved_minor !== p.ledger_reserved) {
      mismatches.push({
        kind: 'PROGRAM_RESERVED',
        ...base,
        stored: `${p.reserved_minor}`,
        fromLedger: `${p.ledger_reserved}`,
      });
    }
    if (p.ledger_limit === null || p.limit_minor !== p.ledger_limit) {
      mismatches.push({
        kind: 'PROGRAM_LIMIT',
        ...base,
        stored: `${p.limit_minor}`,
        fromLedger: `${p.ledger_limit ?? 'none'}`,
      });
    }
  }
  for (const r of reservations.rows) {
    mismatches.push({
      kind: 'RESERVATION_OUTSTANDING',
      tenantId: r.tenant_id,
      programId: r.program_id,
      reservationId: r.id,
      stored: `${r.outstanding}`,
      fromLedger: `${r.ledger_outstanding}`,
    });
  }
  return { programsChecked: programs.rows.length, mismatches };
}
