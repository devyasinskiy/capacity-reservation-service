import type { Money } from '../../../shared/money/money';
import type { ReservationState } from '../domain/reservation';

/** Wire format for money: integer minor units as a string + ISO 4217 code (ADR-002). */
export interface MoneyView {
  readonly amountMinor: string;
  readonly currency: string;
}

/** Current capacity of one program, as returned by `GET …/availability` and the SSE stream. */
export interface AvailabilityView {
  readonly programId: string;
  readonly currency: string;
  readonly limit: MoneyView;
  readonly reserved: MoneyView;
  /** limit − reserved; negative when treasury lowered the limit below usage (ADR-013). */
  readonly available: MoneyView;
  readonly overLimit: boolean;
  /** Increments on every change; lets clients (and SSE) detect missed updates. */
  readonly version: string;
  readonly asOf: string;
}

/** A reservation with original, released and outstanding amounts in both currencies. */
export interface ReservationView {
  readonly id: string;
  readonly programId: string;
  readonly invoiceId: string;
  readonly origin: 'LOCAL' | 'EXTERNAL';
  readonly externalRef: string | null;
  readonly status: 'ACTIVE' | 'PARTIALLY_RELEASED' | 'RELEASED';
  readonly invoiceAmount: MoneyView;
  readonly releasedInvoiceAmount: MoneyView;
  readonly outstandingInvoiceAmount: MoneyView;
  readonly programAmount: MoneyView;
  readonly releasedProgramAmount: MoneyView;
  readonly outstandingProgramAmount: MoneyView;
  readonly fx: { readonly rate: string; readonly source: string; readonly asOf: string };
  readonly createdAt: string;
}

/** Result of a release: the updated reservation and what this release freed. */
export interface ReleaseView {
  readonly reservation: ReservationView;
  readonly release: {
    readonly releasedInvoiceAmount: MoneyView;
    readonly freedProgramAmount: MoneyView;
  };
}

/** One ledger movement with its provenance (ADR-008). */
export interface LedgerEntryView {
  readonly id: string;
  readonly type: string;
  readonly reservationId: string | null;
  readonly reservedDelta: MoneyView;
  readonly limitAfter: MoneyView;
  readonly reservedAfter: MoneyView;
  readonly source: string;
  readonly sourceRef: string | null;
  readonly correlationId: string | null;
  readonly occurredAt: string;
}

/** A reconciliation discrepancy flagged for review (ADR-011). */
export interface DiscrepancyView {
  readonly id: string;
  readonly kind: 'MISSING_LOCALLY' | 'MISSING_IN_TREASURY' | 'AMOUNT_MISMATCH';
  readonly origin: 'LOCAL' | 'EXTERNAL';
  /** LOCAL: our reservation id; EXTERNAL: treasury's externalRef. */
  readonly reservationRef: string;
  readonly invoiceId: string;
  readonly localOutstanding: MoneyView | null;
  readonly treasuryOutstanding: MoneyView | null;
  /** Consecutive snapshots that reproduced it: PENDING at 1, OPEN (flagged) at 2 (ADR-011). */
  readonly strikes: number;
  readonly status: 'PENDING' | 'OPEN' | 'CLEARED';
  readonly firstRunId: string;
  readonly lastRunId: string;
  readonly detectedAt: string;
  readonly updatedAt: string;
}

/** A cursor-paginated slice of results. */
export interface Page<T> {
  readonly items: readonly T[];
  /** Opaque; pass back as `cursor` to fetch the next page. Null on the last page. */
  readonly nextCursor: string | null;
}

/** Converts {@link Money} to its wire format. */
export const moneyView = (m: Money): MoneyView => m.toJSON();

/** Maps reservation state to its API view, deriving the outstanding amounts. */
export function toReservationView(s: ReservationState): ReservationView {
  return {
    id: s.id,
    programId: s.programId,
    invoiceId: s.invoiceId,
    origin: s.origin,
    externalRef: s.externalRef,
    status: s.status,
    invoiceAmount: moneyView(s.invoiceAmount),
    releasedInvoiceAmount: moneyView(s.releasedInvoice),
    outstandingInvoiceAmount: moneyView(s.invoiceAmount.subtract(s.releasedInvoice)),
    programAmount: moneyView(s.programAmount),
    releasedProgramAmount: moneyView(s.releasedProgram),
    outstandingProgramAmount: moneyView(s.programAmount.subtract(s.releasedProgram)),
    fx: { rate: s.fx.rate, source: s.fx.source, asOf: s.fx.asOf.toISOString() },
    createdAt: s.createdAt.toISOString(),
  };
}
