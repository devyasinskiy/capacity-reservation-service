import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely row types for the schema in src/database/migrations. int8 columns are parsed to
 * `bigint` by the pool's type parser (see database.ts); numeric stays a string (exact).
 */
type Int8 = ColumnType<bigint, bigint, bigint>;
type Timestamp = ColumnType<Date, Date | undefined, Date>;
type Json<T> = ColumnType<T, string, string>;

/** `programs`: one row per program; holds limit, reserved and the watermarks (ADR-005/010). */
export interface ProgramsTable {
  tenant_id: string;
  program_id: string;
  currency: string;
  limit_minor: Int8;
  reserved_minor: Int8;
  row_version: Generated<bigint>;
  limit_version: Int8;
  snapshot_version: ColumnType<bigint, bigint | undefined, bigint>;
  last_snapshot_as_of: Date | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** `reservations`: one row per capacity hold, with its FX lock (ADR-003). */
export interface ReservationsTable {
  id: string;
  tenant_id: string;
  program_id: string;
  invoice_id: string;
  origin: 'LOCAL' | 'EXTERNAL';
  external_ref: string | null;
  status: 'ACTIVE' | 'PARTIALLY_RELEASED' | 'RELEASED';
  invoice_currency: string;
  invoice_amount_minor: Int8;
  released_invoice_minor: Int8;
  program_currency: string;
  program_amount_minor: Int8;
  released_program_minor: Int8;
  fx_rate: string;
  fx_source: string;
  fx_as_of: Date;
  created_at: Date;
  updated_at: Timestamp;
}

/** `ledger_entries`: append-only movement log explaining every balance (ADR-008). */
export interface LedgerEntriesTable {
  id: Generated<bigint>;
  tenant_id: string;
  program_id: string;
  reservation_id: string | null;
  type: string;
  reserved_delta_minor: Int8;
  limit_after_minor: Int8;
  reserved_after_minor: Int8;
  source: 'HTTP' | 'KAFKA' | 'SYSTEM';
  source_ref: string | null;
  correlation_id: string | null;
  occurred_at: Timestamp;
}

/** `idempotency_keys`: stored responses for replaying retried HTTP writes (ADR-006). */
export interface IdempotencyKeysTable {
  tenant_id: string;
  key: string;
  operation: string;
  request_hash: string;
  response_status: number;
  response_body: Json<unknown>;
  created_at: Timestamp;
}

/** `inbox_messages`: processed Kafka message IDs for deduplication (ADR-009). */
export interface InboxMessagesTable {
  message_id: string;
  tenant_id: string;
  program_id: string;
  type: string;
  version: Int8;
  topic: string;
  partition: number;
  offset: string;
  outcome: string;
  processed_at: Timestamp;
}

/** `snapshot_parts`: staged chunks of a reconciliation snapshot until complete (ADR-020). */
export interface SnapshotPartsTable {
  tenant_id: string;
  program_id: string;
  snapshot_id: string;
  part: number;
  total_parts: number;
  version: Int8;
  header: Json<unknown>;
  reservations: Json<unknown>;
  received_at: Timestamp;
}

/** `reconciliation_runs`: one row per applied snapshot, with totals (ADR-011). */
export interface ReconciliationRunsTable {
  id: string;
  tenant_id: string;
  program_id: string;
  snapshot_id: string;
  version: Int8;
  as_of: Date;
  treasury_limit_minor: Int8;
  limit_applied: boolean;
  treasury_total_minor: Int8;
  local_total_minor: Int8;
  uncertain_count: number;
  discrepancy_count: number;
  correlation_id: string | null;
  applied_at: Timestamp;
}

/** `reconciliation_discrepancies`: flagged differences under the two-strike rule (ADR-011). */
export interface ReconciliationDiscrepanciesTable {
  id: string;
  first_run_id: string;
  last_run_id: string;
  tenant_id: string;
  program_id: string;
  kind: 'MISSING_LOCALLY' | 'MISSING_IN_TREASURY' | 'AMOUNT_MISMATCH';
  origin: 'LOCAL' | 'EXTERNAL';
  reservation_ref: string;
  invoice_id: string;
  local_outstanding_minor: bigint | null;
  treasury_outstanding_minor: bigint | null;
  strikes: ColumnType<number, number | undefined, number>;
  status: 'PENDING' | 'OPEN' | 'CLEARED';
  correlation_id: string | null;
  detected_at: Timestamp;
  updated_at: Timestamp;
}

/** Kysely schema: table name → row type. */
export interface Database {
  programs: ProgramsTable;
  reservations: ReservationsTable;
  ledger_entries: LedgerEntriesTable;
  idempotency_keys: IdempotencyKeysTable;
  inbox_messages: InboxMessagesTable;
  snapshot_parts: SnapshotPartsTable;
  reconciliation_runs: ReconciliationRunsTable;
  reconciliation_discrepancies: ReconciliationDiscrepanciesTable;
}
