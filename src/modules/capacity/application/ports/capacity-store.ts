import type { LedgerMovement } from '../../domain/ledger-movement';
import type { IdempotencyRecord } from '../idempotency';
import type { Program } from '../../domain/program';
import type {
  Classification,
  LocalEntryAsOf,
  PendingDiscrepancy,
  SnapshotDiff,
  SnapshotEntry,
} from '../../domain/reconciliation';

import type { Reservation } from '../../domain/reservation';

/** Identifies a program within a tenant; every store access is tenant-scoped (ADR-017). */
export interface ProgramKey {
  readonly tenantId: string;
  readonly programId: string;
}

/** Provenance written to every ledger row (ADR-008, ADR-018). */
export interface ChangeContext {
  readonly source: 'HTTP' | 'KAFKA' | 'SYSTEM';
  /** Idempotency-Key, Kafka messageId, … */
  readonly sourceRef?: string | null;
  readonly correlationId?: string | null;
}

/** Dedup record for a consumed Kafka message (ADR-010), written in the effect's transaction. */
export interface InboxEntry {
  readonly messageId: string;
  readonly type: string;
  readonly version: bigint;
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
  readonly outcome: 'APPLIED' | 'STAGED' | 'STALE' | 'ALREADY_APPLIED';
}

/** Fields every part of one snapshot must agree on (ADR-020). */
export interface SnapshotHeader {
  readonly snapshotId: string;
  readonly version: bigint;
  readonly asOf: Date;
  readonly currency: string;
  readonly limitMinor: string;
  readonly totalParts: number;
}

/** A chunked snapshot staged for this program and how many of its parts have arrived. */
export interface StagedSnapshot {
  readonly header: SnapshotHeader;
  readonly parts: number;
}

/** Everything {@link LockedProgramSession.recordReconciliation} persists for one run. */
export interface ReconciliationRecord {
  readonly runId: string;
  readonly header: SnapshotHeader;
  readonly diff: SnapshotDiff;
  readonly classification: Classification;
  readonly limitApplied: boolean;
}

/**
 * Work performed while holding the program's row lock (ADR-005). Everything here runs in one
 * database transaction; when `work` resolves, the program state is persisted and the transaction
 * commits. If `work` throws, nothing is written.
 */
export interface LockedProgramSession {
  readonly program: Program;
  /** Reservation of this program by ID, or null. */
  findReservation(reservationId: string): Promise<Reservation | null>;
  /** The non-released LOCAL reservation for an invoice, or null (one per invoice, ADR-006). */
  findLiveLocalReservationByInvoice(invoiceId: string): Promise<Reservation | null>;
  /** EXTERNAL reservation by treasury's reference, or null. */
  findReservationByExternalRef(externalRef: string): Promise<Reservation | null>;
  /** Inserts or updates a reservation. */
  saveReservation(reservation: Reservation): Promise<void>;
  /** Call after saveReservation for movements that reference a new reservation (FK). */
  recordMovement(movement: LedgerMovement): Promise<void>;
  /** Stored response for an Idempotency-Key in this tenant, or null. */
  findIdempotencyRecord(key: string): Promise<IdempotencyRecord | null>;
  /** Stored in the same transaction as the effect. Throws IdempotencyKeyRace on PK conflict. */
  saveIdempotencyRecord(record: IdempotencyRecord): Promise<void>;
  /** True if the inbox already holds `messageId` (checked again under the lock). */
  isMessageProcessed(messageId: string): Promise<boolean>;
  /** Marks a Kafka message as processed, in the same transaction as its effect (ADR-010). */
  recordInboxMessage(entry: InboxEntry): Promise<void>;

  // Reconciliation (ADR-011/020)
  /** Snapshots currently staged for this program. */
  stagedSnapshots(): Promise<StagedSnapshot[]>;
  /** False if this part is already staged (duplicate under a different messageId). */
  stageSnapshotPart(
    header: SnapshotHeader,
    part: number,
    entries: readonly SnapshotEntry[],
  ): Promise<boolean>;
  /** Deletes the staged parts of the given snapshots (e.g. superseded by a newer version). */
  discardStagedSnapshots(snapshotIds: readonly string[]): Promise<void>;
  /** First-strike (PENDING) discrepancies from the previous snapshot. */
  pendingDiscrepancies(): Promise<PendingDiscrepancy[]>;
  /** Writes the run, applies the two-strike transitions, deletes the staged parts. */
  recordReconciliation(record: ReconciliationRecord): Promise<void>;
}

/** Write-side persistence: locked program sessions plus lock-free reads for fast paths. */
export interface CapacityStore {
  /** Throws DomainError(PROGRAM_NOT_FOUND) if the program does not exist for this tenant. */
  withLockedProgram<T>(
    key: ProgramKey,
    context: ChangeContext,
    work: (session: LockedProgramSession) => Promise<T>,
  ): Promise<T>;

  /**
   * Inserts a new program and its opening ledger movement (and the inbox entry of the message
   * that created it, atomically); false if the program already exists.
   */
  createProgram(
    program: Program,
    opening: LedgerMovement,
    context: ChangeContext,
    inbox?: InboxEntry,
  ): Promise<boolean>;

  /** Lock-free dedup fast path for consumed messages. */
  isMessageProcessed(messageId: string): Promise<boolean>;

  /** Lock-free: the assembled staged snapshot, or null if absent/incomplete. */
  loadStagedSnapshot(
    key: ProgramKey,
    snapshotId: string,
  ): Promise<{ header: SnapshotHeader; entries: SnapshotEntry[] } | null>;

  /** Lock-free: per-reservation outstanding and last movement time, from ledger rows ≤ asOf. */
  localStateAsOf(key: ProgramKey, asOf: Date): Promise<LocalEntryAsOf[]>;

  /** Deletes staged parts received before `olderThan` (any program). Returns rows deleted. */
  purgeStagedSnapshotParts(olderThan: Date): Promise<number>;

  /** Consistent single-row read of current capacity, no lock. */
  findProgram(key: ProgramKey): Promise<Program | null>;

  /** Lock-free read for the idempotency fast path (before FX lookup and locking). */
  findIdempotencyRecord(tenantId: string, key: string): Promise<IdempotencyRecord | null>;

  /** Lock-free read: lets a retried reserve replay without needing an FX quote. */
  findLiveLocalReservationByInvoice(
    key: ProgramKey,
    invoiceId: string,
  ): Promise<Reservation | null>;
}

/** DI token for {@link CapacityStore}. */
export const CAPACITY_STORE = Symbol('CapacityStore');
