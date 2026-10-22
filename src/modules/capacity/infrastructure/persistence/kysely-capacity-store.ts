import { type Kysely, sql, type Transaction } from 'kysely';
import type { Database } from '../../../../shared/database/database.types';
import { DomainError } from '../../../../shared/errors/domain-error';
import type {
  CapacityStore,
  ChangeContext,
  InboxEntry,
  LockedProgramSession,
  ProgramKey,
  ReconciliationRecord,
  SnapshotHeader,
  StagedSnapshot,
} from '../../application/ports/capacity-store';
import type {
  LocalEntryAsOf,
  PendingDiscrepancy,
  SnapshotEntry,
} from '../../domain/reconciliation';
import type { LedgerMovement } from '../../domain/ledger-movement';
import type { Program } from '../../domain/program';
import type { Reservation } from '../../domain/reservation';
import { IdempotencyKeyRace, type IdempotencyRecord } from '../../application/idempotency';
import { CAPACITY_CHANNEL } from '../notifications/pg-availability-changes';
import { translateDbError } from './pg-errors';
import * as recon from './reconciliation-sql';
import { toProgram, toReservation } from './row-mappers';

/** Per-transaction `lock_timeout` / `statement_timeout`, so a hot program sheds load (ADR-005). */
export interface StoreTimeouts {
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

/**
 * Postgres implementation of the capacity store. Concurrency strategy (ADR-005): one READ
 * COMMITTED transaction per command, `SELECT … FOR UPDATE` on the program row first, so every
 * write on a program — HTTP or Kafka — is serialized; the domain decides; then we persist.
 */
export class KyselyCapacityStore implements CapacityStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly timeouts: StoreTimeouts,
  ) {}

  /**
   * Opens a transaction, locks the program row with `FOR UPDATE`, runs `work`, persists the
   * program and commits. Postgres errors are translated to RetryableError where transient.
   */
  async withLockedProgram<T>(
    key: ProgramKey,
    context: ChangeContext,
    work: (session: LockedProgramSession) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        await this.applyTimeouts(trx);
        const row = await trx
          .selectFrom('programs')
          .selectAll()
          .where('tenant_id', '=', key.tenantId)
          .where('program_id', '=', key.programId)
          .forUpdate()
          .executeTakeFirst();
        if (!row) {
          throw new DomainError('PROGRAM_NOT_FOUND', 'Program not found', {
            programId: key.programId,
          });
        }
        const session = new KyselyLockedSession(trx, toProgram(row), context);
        const result = await work(session);
        await session.persistProgram();
        return result;
      });
    } catch (error) {
      throw translateDbError(error);
    }
  }

  /** Inserts program + opening ledger row (+ inbox entry), notifies; false if it exists. */
  async createProgram(
    program: Program,
    opening: LedgerMovement,
    context: ChangeContext,
    inbox?: InboxEntry,
  ): Promise<boolean> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        await this.applyTimeouts(trx);
        const s = program.toState();
        const inserted = await trx
          .insertInto('programs')
          .values({
            tenant_id: s.tenantId,
            program_id: s.programId,
            currency: s.limit.currency.code,
            limit_minor: s.limit.minor,
            reserved_minor: s.reserved.minor,
            limit_version: s.limitVersion,
            snapshot_version: s.snapshotVersion,
          })
          .onConflict((oc) => oc.columns(['tenant_id', 'program_id']).doNothing())
          .returning('program_id')
          .executeTakeFirst();
        if (!inserted) return false;
        await insertMovement(trx, program, opening, context);
        if (inbox) await insertInbox(trx, program, inbox);
        await notifyCapacityChanged(trx, s.tenantId, s.programId, 0n);
        return true;
      });
    } catch (error) {
      throw translateDbError(error);
    }
  }

  /** Unlocked single-row read of the program. */
  async findProgram(key: ProgramKey): Promise<Program | null> {
    try {
      const row = await this.db
        .selectFrom('programs')
        .selectAll()
        .where('tenant_id', '=', key.tenantId)
        .where('program_id', '=', key.programId)
        .executeTakeFirst();
      return row ? toProgram(row) : null;
    } catch (error) {
      throw translateDbError(error);
    }
  }

  /** Unlocked inbox lookup. */
  async isMessageProcessed(messageId: string): Promise<boolean> {
    try {
      return await inboxContains(this.db, messageId);
    } catch (error) {
      throw translateDbError(error);
    }
  }

  /** Unlocked idempotency-key lookup. */
  async findIdempotencyRecord(tenantId: string, key: string): Promise<IdempotencyRecord | null> {
    try {
      return await readIdempotencyRecord(this.db, tenantId, key);
    } catch (error) {
      throw translateDbError(error);
    }
  }

  /** Unlocked lookup of the non-released LOCAL reservation for an invoice. */
  async findLiveLocalReservationByInvoice(
    key: ProgramKey,
    invoiceId: string,
  ): Promise<Reservation | null> {
    try {
      const row = await this.db
        .selectFrom('reservations')
        .selectAll()
        .where('tenant_id', '=', key.tenantId)
        .where('program_id', '=', key.programId)
        .where('invoice_id', '=', invoiceId)
        .where('origin', '=', 'LOCAL')
        .where('status', '<>', 'RELEASED')
        .executeTakeFirst();
      return row ? toReservation(row) : null;
    } catch (error) {
      throw translateDbError(error);
    }
  }

  /** Unlocked; see {@link recon.loadStagedSnapshot}. */
  loadStagedSnapshot(key: ProgramKey, snapshotId: string) {
    return this.guard(() => recon.loadStagedSnapshot(this.db, key, snapshotId));
  }

  /** Unlocked ledger replay up to `asOf`; see {@link recon.localStateAsOf}. */
  localStateAsOf(key: ProgramKey, asOf: Date): Promise<LocalEntryAsOf[]> {
    return this.guard(() => recon.localStateAsOf(this.db, key, asOf));
  }

  /** See {@link recon.purgeStagedSnapshotParts}. */
  purgeStagedSnapshotParts(olderThan: Date): Promise<number> {
    return this.guard(() => recon.purgeStagedSnapshotParts(this.db, olderThan));
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw translateDbError(error);
    }
  }

  private async applyTimeouts(trx: Transaction<Database>): Promise<void> {
    // SET LOCAL equivalents (is_local = true): scoped to this transaction only.
    await sql`select set_config('lock_timeout', ${`${this.timeouts.lockTimeoutMs}ms`}, true),
                     set_config('statement_timeout', ${`${this.timeouts.statementTimeoutMs}ms`}, true)`.execute(
      trx,
    );
  }
}

class KyselyLockedSession implements LockedProgramSession {
  constructor(
    private readonly trx: Transaction<Database>,
    readonly program: Program,
    private readonly context: ChangeContext,
  ) {}

  async findReservation(reservationId: string): Promise<Reservation | null> {
    if (!UUID.test(reservationId)) return null; // avoid a uuid cast error for malformed ids
    return this.findOne((q) => q.where('id', '=', reservationId));
  }

  findLiveLocalReservationByInvoice(invoiceId: string): Promise<Reservation | null> {
    return this.findOne((q) =>
      q
        .where('invoice_id', '=', invoiceId)
        .where('origin', '=', 'LOCAL')
        .where('status', '<>', 'RELEASED'),
    );
  }

  findReservationByExternalRef(externalRef: string): Promise<Reservation | null> {
    return this.findOne((q) => q.where('external_ref', '=', externalRef));
  }

  async saveReservation(reservation: Reservation): Promise<void> {
    const s = reservation.toState();
    await this.trx
      .insertInto('reservations')
      .values({
        id: s.id,
        tenant_id: s.tenantId,
        program_id: s.programId,
        invoice_id: s.invoiceId,
        origin: s.origin,
        external_ref: s.externalRef,
        status: s.status,
        invoice_currency: s.invoiceAmount.currency.code,
        invoice_amount_minor: s.invoiceAmount.minor,
        released_invoice_minor: s.releasedInvoice.minor,
        program_currency: s.programAmount.currency.code,
        program_amount_minor: s.programAmount.minor,
        released_program_minor: s.releasedProgram.minor,
        fx_rate: s.fx.rate,
        fx_source: s.fx.source,
        fx_as_of: s.fx.asOf,
        created_at: s.createdAt,
      })
      // Only release progress is mutable; amounts, FX lock and identity never change.
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          status: s.status,
          released_invoice_minor: s.releasedInvoice.minor,
          released_program_minor: s.releasedProgram.minor,
          updated_at: sql<Date>`clock_timestamp()`,
        }),
      )
      .execute();
  }

  recordMovement(movement: LedgerMovement): Promise<void> {
    return insertMovement(this.trx, this.program, movement, this.context);
  }

  findIdempotencyRecord(key: string): Promise<IdempotencyRecord | null> {
    return readIdempotencyRecord(this.trx, this.program.tenantId, key);
  }

  isMessageProcessed(messageId: string): Promise<boolean> {
    return inboxContains(this.trx, messageId);
  }

  recordInboxMessage(entry: InboxEntry): Promise<void> {
    return insertInbox(this.trx, this.program, entry);
  }

  stagedSnapshots(): Promise<StagedSnapshot[]> {
    return recon.stagedSnapshots(this.trx, this.key());
  }

  stageSnapshotPart(
    header: SnapshotHeader,
    part: number,
    entries: readonly SnapshotEntry[],
  ): Promise<boolean> {
    return recon.stageSnapshotPart(this.trx, this.key(), header, part, entries);
  }

  discardStagedSnapshots(snapshotIds: readonly string[]): Promise<void> {
    return recon.discardStagedSnapshots(this.trx, this.key(), snapshotIds);
  }

  pendingDiscrepancies(): Promise<PendingDiscrepancy[]> {
    return recon.pendingDiscrepancies(this.trx, this.key());
  }

  recordReconciliation(record: ReconciliationRecord): Promise<void> {
    return recon.recordReconciliation(this.trx, this.key(), record, this.context);
  }

  private key(): ProgramKey {
    return { tenantId: this.program.tenantId, programId: this.program.programId };
  }

  async saveIdempotencyRecord(record: IdempotencyRecord): Promise<void> {
    try {
      await this.trx
        .insertInto('idempotency_keys')
        .values({
          tenant_id: this.program.tenantId,
          key: record.key,
          operation: record.operation,
          request_hash: record.requestHash,
          response_status: record.responseStatus,
          response_body: JSON.stringify(record.responseBody),
        })
        .execute();
    } catch (error) {
      // A concurrent request (for another program, so not serialised by our row lock) committed
      // the same key first. The whole transaction rolls back; the caller replays the winner.
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new IdempotencyKeyRace();
      throw error;
    }
  }

  async persistProgram(): Promise<void> {
    const s = this.program.toState();
    const row = await this.trx
      .updateTable('programs')
      .set({
        limit_minor: s.limit.minor,
        reserved_minor: s.reserved.minor,
        limit_version: s.limitVersion,
        snapshot_version: s.snapshotVersion,
        row_version: sql<bigint>`row_version + 1`,
        updated_at: sql<Date>`clock_timestamp()`,
      })
      .where('tenant_id', '=', s.tenantId)
      .where('program_id', '=', s.programId)
      .returning('row_version')
      .executeTakeFirstOrThrow();
    await notifyCapacityChanged(this.trx, s.tenantId, s.programId, row.row_version);
  }

  private async findOne(
    filter: (
      q: ReturnType<KyselyLockedSession['baseQuery']>,
    ) => ReturnType<KyselyLockedSession['baseQuery']>,
  ): Promise<Reservation | null> {
    const row = await filter(this.baseQuery()).executeTakeFirst();
    return row ? toReservation(row) : null;
  }

  private baseQuery() {
    return this.trx
      .selectFrom('reservations')
      .selectAll()
      .where('tenant_id', '=', this.program.tenantId)
      .where('program_id', '=', this.program.programId);
  }
}

const UNIQUE_VIOLATION = '23505';

/**
 * Queued inside the write transaction; Postgres delivers it only if the transaction commits
 * (ADR-014). Payload carries ids only (NOTIFY payloads are limited to 8 kB).
 */
async function notifyCapacityChanged(
  trx: Transaction<Database>,
  tenantId: string,
  programId: string,
  version: bigint,
): Promise<void> {
  const payload = JSON.stringify({ tenantId, programId, version: version.toString() });
  await sql`select pg_notify(${CAPACITY_CHANNEL}, ${payload})`.execute(trx);
}

async function inboxContains(
  db: Kysely<Database> | Transaction<Database>,
  messageId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('inbox_messages')
    .select('message_id')
    .where('message_id', '=', messageId)
    .executeTakeFirst();
  return row !== undefined;
}

async function insertInbox(
  trx: Transaction<Database>,
  program: Program,
  e: InboxEntry,
): Promise<void> {
  await trx
    .insertInto('inbox_messages')
    .values({
      message_id: e.messageId,
      tenant_id: program.tenantId,
      program_id: program.programId,
      type: e.type,
      version: e.version,
      topic: e.topic,
      partition: e.partition,
      offset: e.offset,
      outcome: e.outcome,
    })
    .execute();
}

async function readIdempotencyRecord(
  db: Kysely<Database> | Transaction<Database>,
  tenantId: string,
  key: string,
): Promise<IdempotencyRecord | null> {
  const row = await db
    .selectFrom('idempotency_keys')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('key', '=', key)
    .executeTakeFirst();
  if (!row) return null;
  return {
    key: row.key,
    operation: row.operation as IdempotencyRecord['operation'],
    requestHash: row.request_hash,
    responseStatus: row.response_status,
    responseBody: row.response_body,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function insertMovement(
  trx: Transaction<Database>,
  program: Program,
  m: LedgerMovement,
  context: ChangeContext,
): Promise<void> {
  await trx
    .insertInto('ledger_entries')
    .values({
      tenant_id: program.tenantId,
      program_id: program.programId,
      reservation_id: m.reservationId,
      type: m.type,
      reserved_delta_minor: m.reservedDelta,
      limit_after_minor: m.limitAfter,
      reserved_after_minor: m.reservedAfter,
      source: context.source,
      source_ref: context.sourceRef ?? null,
      correlation_id: context.correlationId ?? null,
    })
    .execute();
}
