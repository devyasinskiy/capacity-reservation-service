import type { Kysely } from 'kysely';
import type { Database } from '../../../../shared/database/database.types';
import { DomainError } from '../../../../shared/errors/domain-error';
import { Money } from '../../../../shared/money/money';
import type { CapacityReadModel } from '../../application/ports/capacity-read-model';
import type { ProgramKey } from '../../application/ports/capacity-store';
import {
  type AvailabilityView,
  type DiscrepancyView,
  type LedgerEntryView,
  moneyView,
  type Page,
  type ReservationView,
  toReservationView,
} from '../../application/views';
import type { ReservationStatus } from '../../domain/reservation';
import { translateDbError } from './pg-errors';
import { toProgram, toReservation } from './row-mappers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keyset pagination (stable under concurrent inserts, O(limit) per page). */
export class KyselyCapacityReadModel implements CapacityReadModel {
  constructor(private readonly db: Kysely<Database>) {}

  /** Single-row read of `programs`. @throws DomainError `PROGRAM_NOT_FOUND`. */
  async getAvailability(key: ProgramKey): Promise<AvailabilityView> {
    const row = await this.guard(() =>
      this.db
        .selectFrom('programs')
        .selectAll()
        .where('tenant_id', '=', key.tenantId)
        .where('program_id', '=', key.programId)
        .executeTakeFirst(),
    );
    if (!row) throw programNotFound(key);
    const program = toProgram(row);
    return {
      programId: program.programId,
      currency: program.currencyCode,
      limit: moneyView(program.limit),
      reserved: moneyView(program.reserved),
      available: moneyView(program.available),
      overLimit: program.overLimit,
      version: row.row_version.toString(),
      asOf: row.updated_at.toISOString(),
    };
  }

  /**
   * One reservation of the program.
   * @throws DomainError `PROGRAM_NOT_FOUND` or `RESERVATION_NOT_FOUND` (also for a non-UUID ID).
   */
  async getReservation(key: ProgramKey, reservationId: string): Promise<ReservationView> {
    await this.programCurrency(key);
    const row = UUID.test(reservationId)
      ? await this.guard(() =>
          this.db
            .selectFrom('reservations')
            .selectAll()
            .where('tenant_id', '=', key.tenantId)
            .where('program_id', '=', key.programId)
            .where('id', '=', reservationId)
            .executeTakeFirst(),
        )
      : undefined;
    if (!row) {
      throw new DomainError('RESERVATION_NOT_FOUND', 'Reservation not found', { reservationId });
    }
    return toReservationView(toReservation(row).toState());
  }

  /** Newest first, keyset on `(created_at, id)`. @throws DomainError `INVALID_CURSOR`. */
  async listReservations(
    key: ProgramKey,
    query: { status?: ReservationStatus; limit: number; cursor?: string },
  ): Promise<Page<ReservationView>> {
    await this.programCurrency(key);
    const after = query.cursor ? decodeCursor(query.cursor, isReservationCursor) : undefined;
    const rows = await this.guard(() => {
      let q = this.db
        .selectFrom('reservations')
        .selectAll()
        .where('tenant_id', '=', key.tenantId)
        .where('program_id', '=', key.programId);
      if (query.status) q = q.where('status', '=', query.status);
      if (after) {
        const createdAt = new Date(after.c);
        q = q.where((eb) =>
          eb.or([
            eb('created_at', '<', createdAt),
            eb.and([eb('created_at', '=', createdAt), eb('id', '<', after.i)]),
          ]),
        );
      }
      return q
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(query.limit + 1)
        .execute();
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => toReservationView(toReservation(r).toState())),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ c: last.created_at.toISOString(), i: last.id })
          : null,
    };
  }

  /** Newest first, keyset on the ledger `id`. @throws DomainError `INVALID_CURSOR`. */
  async getLedger(
    key: ProgramKey,
    query: { limit: number; cursor?: string },
  ): Promise<Page<LedgerEntryView>> {
    const currency = await this.programCurrency(key);
    const after = query.cursor ? decodeCursor(query.cursor, isLedgerCursor) : undefined;
    const rows = await this.guard(() => {
      let q = this.db
        .selectFrom('ledger_entries')
        .selectAll()
        .where('tenant_id', '=', key.tenantId)
        .where('program_id', '=', key.programId);
      if (after) q = q.where('id', '<', BigInt(after.id));
      return q
        .orderBy('id', 'desc')
        .limit(query.limit + 1)
        .execute();
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const money = (minor: bigint) => moneyView(Money.of(minor, currency));
    return {
      items: page.map((r) => ({
        id: r.id.toString(),
        type: r.type,
        reservationId: r.reservation_id,
        reservedDelta: money(r.reserved_delta_minor),
        limitAfter: money(r.limit_after_minor),
        reservedAfter: money(r.reserved_after_minor),
        source: r.source,
        sourceRef: r.source_ref,
        correlationId: r.correlation_id,
        occurredAt: r.occurred_at.toISOString(),
      })),
      nextCursor:
        rows.length > query.limit && last ? encodeCursor({ id: last.id.toString() }) : null,
    };
  }

  /** Newest first, keyset on `(detected_at, id)`. @throws DomainError `INVALID_CURSOR`. */
  async listDiscrepancies(
    key: ProgramKey,
    query: { status?: DiscrepancyView['status']; limit: number; cursor?: string },
  ): Promise<Page<DiscrepancyView>> {
    const currency = await this.programCurrency(key);
    const after = query.cursor ? decodeCursor(query.cursor, isReservationCursor) : undefined;
    const rows = await this.guard(() => {
      let q = this.db
        .selectFrom('reconciliation_discrepancies')
        .selectAll()
        .where('tenant_id', '=', key.tenantId)
        .where('program_id', '=', key.programId);
      if (query.status) q = q.where('status', '=', query.status);
      if (after) {
        const at = new Date(after.c);
        q = q.where((eb) =>
          eb.or([
            eb('detected_at', '<', at),
            eb.and([eb('detected_at', '=', at), eb('id', '<', after.i)]),
          ]),
        );
      }
      return q
        .orderBy('detected_at', 'desc')
        .orderBy('id', 'desc')
        .limit(query.limit + 1)
        .execute();
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const money = (minor: bigint | null) =>
      minor === null ? null : moneyView(Money.of(minor, currency));
    return {
      items: page.map((r) => ({
        id: r.id,
        kind: r.kind,
        origin: r.origin,
        reservationRef: r.reservation_ref,
        invoiceId: r.invoice_id,
        localOutstanding: money(r.local_outstanding_minor),
        treasuryOutstanding: money(r.treasury_outstanding_minor),
        strikes: r.strikes,
        status: r.status,
        firstRunId: r.first_run_id,
        lastRunId: r.last_run_id,
        detectedAt: r.detected_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      })),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ c: last.detected_at.toISOString(), i: last.id })
          : null,
    };
  }

  /** Also the tenant/existence check for every program-scoped query. */
  private async programCurrency(key: ProgramKey): Promise<string> {
    const row = await this.guard(() =>
      this.db
        .selectFrom('programs')
        .select('currency')
        .where('tenant_id', '=', key.tenantId)
        .where('program_id', '=', key.programId)
        .executeTakeFirst(),
    );
    if (!row) throw programNotFound(key);
    return row.currency;
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw translateDbError(error);
    }
  }
}

const programNotFound = (key: ProgramKey) =>
  new DomainError('PROGRAM_NOT_FOUND', 'Program not found', { programId: key.programId });

type ReservationCursor = { c: string; i: string };
type LedgerCursor = { id: string };

const isReservationCursor = (v: unknown): v is ReservationCursor =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as ReservationCursor).c === 'string' &&
  !Number.isNaN(Date.parse((v as ReservationCursor).c)) &&
  typeof (v as ReservationCursor).i === 'string' &&
  UUID.test((v as ReservationCursor).i);

const isLedgerCursor = (v: unknown): v is LedgerCursor =>
  typeof v === 'object' && v !== null && /^\d{1,19}$/.test(String((v as LedgerCursor).id));

function encodeCursor(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor<T>(cursor: string, guard: (v: unknown) => v is T): T {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (guard(value)) return value;
  } catch {
    // fall through
  }
  throw new DomainError('INVALID_CURSOR', 'cursor is not valid for this listing');
}
