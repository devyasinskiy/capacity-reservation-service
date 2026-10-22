import { randomUUID } from 'node:crypto';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { Database } from '../../../../shared/database/database.types';
import type {
  ChangeContext,
  ProgramKey,
  ReconciliationRecord,
  SnapshotHeader,
  StagedSnapshot,
} from '../../application/ports/capacity-store';
import type {
  DiscrepancyCandidate,
  LocalEntryAsOf,
  PendingDiscrepancy,
  SnapshotEntry,
} from '../../domain/reconciliation';

type Db = Kysely<Database> | Transaction<Database>;

/** jsonb wire shapes: bigint/Date as strings (jsonb has no bigint). */
interface HeaderJson {
  snapshotId: string;
  version: string;
  asOf: string;
  currency: string;
  limitMinor: string;
  totalParts: number;
}
type EntryJson = {
  origin: 'LOCAL' | 'EXTERNAL';
  ref: string;
  invoiceId: string;
  outstandingMinor: string;
};

const toHeaderJson = (h: SnapshotHeader): HeaderJson => ({
  snapshotId: h.snapshotId,
  version: h.version.toString(),
  asOf: h.asOf.toISOString(),
  currency: h.currency,
  limitMinor: h.limitMinor,
  totalParts: h.totalParts,
});
const fromHeaderJson = (h: HeaderJson): SnapshotHeader => ({
  ...h,
  version: BigInt(h.version),
  asOf: new Date(h.asOf),
});

/** One row per staged snapshot: its header (identical on every part) and how many parts arrived. */
export async function stagedSnapshots(db: Db, key: ProgramKey): Promise<StagedSnapshot[]> {
  const result = await sql<{ snapshot_id: string; parts: string; header: HeaderJson }>`
    select distinct on (snapshot_id) snapshot_id,
           count(*) over (partition by snapshot_id) as parts,
           header
      from snapshot_parts
     where tenant_id = ${key.tenantId} and program_id = ${key.programId}
     order by snapshot_id, part`.execute(db);
  return result.rows.map((r) => ({ header: fromHeaderJson(r.header), parts: Number(r.parts) }));
}

/** Inserts one snapshot part; returns false if that part was already staged. */
export async function stageSnapshotPart(
  trx: Transaction<Database>,
  key: ProgramKey,
  header: SnapshotHeader,
  part: number,
  entries: readonly SnapshotEntry[],
): Promise<boolean> {
  const json: EntryJson[] = entries.map((e) => ({
    ...e,
    outstandingMinor: e.outstandingMinor.toString(),
  }));
  const inserted = await trx
    .insertInto('snapshot_parts')
    .values({
      tenant_id: key.tenantId,
      program_id: key.programId,
      snapshot_id: header.snapshotId,
      part,
      total_parts: header.totalParts,
      version: header.version,
      header: JSON.stringify(toHeaderJson(header)),
      reservations: JSON.stringify(json),
    })
    .onConflict((oc) => oc.columns(['tenant_id', 'program_id', 'snapshot_id', 'part']).doNothing())
    .returning('part')
    .executeTakeFirst();
  return inserted !== undefined;
}

/** Deletes all staged parts of the given snapshots for one program. */
export async function discardStagedSnapshots(
  db: Db,
  key: ProgramKey,
  snapshotIds: readonly string[],
): Promise<void> {
  if (snapshotIds.length === 0) return;
  await db
    .deleteFrom('snapshot_parts')
    .where('tenant_id', '=', key.tenantId)
    .where('program_id', '=', key.programId)
    .where('snapshot_id', 'in', [...snapshotIds])
    .execute();
}

/** All entries of a staged snapshot, or null if absent or not all parts have arrived. */
export async function loadStagedSnapshot(
  db: Db,
  key: ProgramKey,
  snapshotId: string,
): Promise<{ header: SnapshotHeader; entries: SnapshotEntry[] } | null> {
  const rows = await db
    .selectFrom('snapshot_parts')
    .select(['part', 'total_parts', 'header', 'reservations'])
    .where('tenant_id', '=', key.tenantId)
    .where('program_id', '=', key.programId)
    .where('snapshot_id', '=', snapshotId)
    .orderBy('part')
    .execute();
  const first = rows[0];
  if (!first || rows.length !== first.total_parts) return null;
  const entries = rows.flatMap((r) =>
    (r.reservations as EntryJson[]).map((e) => ({
      ...e,
      outstandingMinor: BigInt(e.outstandingMinor),
    })),
  );
  return { header: fromHeaderJson(first.header as HeaderJson), entries };
}

/**
 * Our view of each reservation *as of* `asOf`, rebuilt from the append-only ledger (ADR-011).
 * Reservations whose first movement is after asOf are absent by construction — that is what
 * keeps post-asOf activity out of the comparison.
 */
export async function localStateAsOf(
  db: Db,
  key: ProgramKey,
  asOf: Date,
): Promise<LocalEntryAsOf[]> {
  const result = await sql<{
    id: string;
    origin: 'LOCAL' | 'EXTERNAL';
    external_ref: string | null;
    invoice_id: string;
    outstanding: bigint;
    last_at: Date;
  }>`
    select r.id, r.origin, r.external_ref, r.invoice_id,
           sum(l.reserved_delta_minor)::bigint as outstanding,
           max(l.occurred_at) as last_at
      from ledger_entries l
      join reservations r on r.id = l.reservation_id
     where l.tenant_id = ${key.tenantId}
       and l.program_id = ${key.programId}
       and l.occurred_at <= ${asOf}
     group by r.id`.execute(db);
  return result.rows.map((r) => ({
    origin: r.origin,
    ref: r.origin === 'EXTERNAL' ? r.external_ref! : r.id,
    invoiceId: r.invoice_id,
    outstandingMinor: r.outstanding,
    lastMovementAt: r.last_at,
  }));
}

/** PENDING (first-strike) discrepancies of one program. */
export async function pendingDiscrepancies(db: Db, key: ProgramKey): Promise<PendingDiscrepancy[]> {
  const rows = await db
    .selectFrom('reconciliation_discrepancies')
    .select(['id', 'kind', 'origin', 'reservation_ref'])
    .where('tenant_id', '=', key.tenantId)
    .where('program_id', '=', key.programId)
    .where('status', '=', 'PENDING')
    .execute();
  return rows.map((r) => ({ id: r.id, kind: r.kind, origin: r.origin, ref: r.reservation_ref }));
}

/**
 * Inserts the reconciliation run, applies the open/pending/clear transitions and drops the
 * snapshot's staged parts. Must run inside the program-locked transaction.
 */
export async function recordReconciliation(
  trx: Transaction<Database>,
  key: ProgramKey,
  record: ReconciliationRecord,
  context: ChangeContext,
): Promise<void> {
  const { runId, header, diff, classification } = record;
  const correlationId = context.correlationId ?? null;
  await trx
    .insertInto('reconciliation_runs')
    .values({
      id: runId,
      tenant_id: key.tenantId,
      program_id: key.programId,
      snapshot_id: header.snapshotId,
      version: header.version,
      as_of: header.asOf,
      treasury_limit_minor: BigInt(header.limitMinor),
      limit_applied: record.limitApplied,
      treasury_total_minor: diff.treasuryTotalMinor,
      local_total_minor: diff.localTotalMinor,
      uncertain_count: diff.uncertain.length,
      discrepancy_count: diff.candidates.length,
      correlation_id: correlationId,
    })
    .execute();

  const amounts = (c: DiscrepancyCandidate) => ({
    local_outstanding_minor: c.localOutstandingMinor,
    treasury_outstanding_minor: c.treasuryOutstandingMinor,
  });

  if (classification.toPending.length > 0) {
    await trx
      .insertInto('reconciliation_discrepancies')
      .values(
        classification.toPending.map((c) => ({
          id: randomUUID(),
          first_run_id: runId,
          last_run_id: runId,
          tenant_id: key.tenantId,
          program_id: key.programId,
          kind: c.kind,
          origin: c.origin,
          reservation_ref: c.ref,
          invoice_id: c.invoiceId,
          ...amounts(c),
          strikes: 1,
          status: 'PENDING' as const,
          correlation_id: correlationId,
        })),
      )
      .execute();
  }
  for (const { pendingId, candidate } of classification.toOpen) {
    await trx
      .updateTable('reconciliation_discrepancies')
      .set({
        status: 'OPEN',
        strikes: sql<number>`strikes + 1`,
        last_run_id: runId,
        ...amounts(candidate),
        correlation_id: correlationId,
        updated_at: sql<Date>`clock_timestamp()`,
      })
      .where('id', '=', pendingId)
      .execute();
  }
  if (classification.toClear.length > 0) {
    await trx
      .updateTable('reconciliation_discrepancies')
      .set({ status: 'CLEARED', last_run_id: runId, updated_at: sql<Date>`clock_timestamp()` })
      .where('id', 'in', [...classification.toClear])
      .execute();
  }
  await trx
    .updateTable('programs')
    .set({ last_snapshot_as_of: header.asOf })
    .where('tenant_id', '=', key.tenantId)
    .where('program_id', '=', key.programId)
    .execute();
  await discardStagedSnapshots(trx, key, [header.snapshotId]);
}

/**
 * Deletes staged parts received before `olderThan`, across all programs.
 * @returns number of rows deleted.
 */
export async function purgeStagedSnapshotParts(db: Db, olderThan: Date): Promise<number> {
  const result = await db
    .deleteFrom('snapshot_parts')
    .where('received_at', '<', olderThan)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}
