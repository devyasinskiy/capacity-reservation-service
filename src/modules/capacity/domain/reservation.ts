import { DomainError } from '../../../shared/errors/domain-error';
import { Money } from '../../../shared/money/money';
import { divide } from '../../../shared/money/rational';

/** LOCAL = made via this API; EXTERNAL = reported by treasury over Kafka. */
export type ReservationOrigin = 'LOCAL' | 'EXTERNAL';
/** Lifecycle: ACTIVE → PARTIALLY_RELEASED → RELEASED. */
export type ReservationStatus = 'ACTIVE' | 'PARTIALLY_RELEASED' | 'RELEASED';

/** FX rate locked at reservation time; releases use it, never a fresh rate (ADR-003). */
export interface FxLock {
  /** Exact decimal string as quoted; quote units per 1 base unit. */
  readonly rate: string;
  readonly source: string;
  readonly asOf: Date;
}

/** Persisted state of a {@link Reservation}. */
export interface ReservationState {
  readonly id: string;
  readonly tenantId: string;
  readonly programId: string;
  readonly invoiceId: string;
  readonly origin: ReservationOrigin;
  readonly externalRef: string | null;
  readonly status: ReservationStatus;
  /** Invoice currency. */
  readonly invoiceAmount: Money;
  readonly releasedInvoice: Money;
  /** Program currency, locked at reservation time (ADR-003). */
  readonly programAmount: Money;
  readonly releasedProgram: Money;
  readonly fx: FxLock;
  readonly createdAt: Date;
}

/** What one release returned: invoice amount released and program capacity freed. */
export interface ReleaseOutcome {
  readonly releasedInvoice: Money;
  readonly freedProgram: Money;
}

/** A hold on program capacity for one invoice. Mutated only through `release`. */
export class Reservation {
  private constructor(private state: ReservationState) {}

  /** Rehydrates a reservation from persisted state; no validation. */
  static restore(state: ReservationState): Reservation {
    return new Reservation(state);
  }

  /** Creates a new ACTIVE reservation with nothing released. */
  static open(
    params: Omit<ReservationState, 'status' | 'releasedInvoice' | 'releasedProgram'>,
  ): Reservation {
    return new Reservation({
      ...params,
      status: 'ACTIVE',
      releasedInvoice: Money.zero(params.invoiceAmount.currency.code),
      releasedProgram: Money.zero(params.programAmount.currency.code),
    });
  }

  /** Reservation ID. */
  get id(): string {
    return this.state.id;
  }
  /** Owning program. */
  get programId(): string {
    return this.state.programId;
  }
  /** Owning tenant. */
  get tenantId(): string {
    return this.state.tenantId;
  }
  /** Invoice this reservation finances. */
  get invoiceId(): string {
    return this.state.invoiceId;
  }
  /** Current lifecycle status. */
  get status(): ReservationStatus {
    return this.state.status;
  }
  /** Original amount, invoice currency. */
  get invoiceAmount(): Money {
    return this.state.invoiceAmount;
  }
  /** Locked converted amount, program currency (ADR-003). */
  get programAmount(): Money {
    return this.state.programAmount;
  }
  /** Not yet released, invoice currency. */
  get outstandingInvoice(): Money {
    return this.state.invoiceAmount.subtract(this.state.releasedInvoice);
  }
  /** Capacity still held, program currency. */
  get outstandingProgram(): Money {
    return this.state.programAmount.subtract(this.state.releasedProgram);
  }

  /** Current state for persistence. */
  toState(): ReservationState {
    return this.state;
  }

  /** Idempotent-replay check: is a new request for this invoice the same as the original? */
  isSameRequest(invoiceAmount: Money): boolean {
    return this.state.invoiceAmount.equals(invoiceAmount);
  }

  /**
   * Releases `amount` (invoice currency) or, if omitted, the whole remainder.
   * Program capacity freed is the cumulative pro-rata share of the locked amount, rounded DOWN:
   *   freedTotal = floor(P × releasedInvoiceTotal / I)
   * so no drift accumulates and the final release frees exactly P − releasedProgram (ADR-004).
   */
  release(amount?: Money): ReleaseOutcome {
    const { invoiceAmount: I, programAmount: P, releasedInvoice, releasedProgram } = this.state;
    if (this.state.status === 'RELEASED') {
      throw new DomainError(
        'RESERVATION_ALREADY_RELEASED',
        'Reservation is already fully released',
        {
          reservationId: this.state.id,
        },
      );
    }

    const requested = amount ?? this.outstandingInvoice;
    if (!requested.hasCurrency(I.currency.code)) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        `Release must be in the invoice currency ${I.currency.code}`,
        { expected: I.currency.code, actual: requested.currency.code },
      );
    }
    if (!requested.isPositive()) {
      throw new DomainError('INVALID_AMOUNT', 'Release amount must be positive');
    }
    const newReleasedInvoice = releasedInvoice.add(requested);
    if (newReleasedInvoice.greaterThan(I)) {
      throw new DomainError('OVER_RELEASE', 'Release exceeds the outstanding invoice amount', {
        outstandingMinor: this.outstandingInvoice.minor.toString(),
        requestedMinor: requested.minor.toString(),
      });
    }

    // When newReleasedInvoice == I this is exactly P (P × I / I), so the last release is exact.
    const newReleasedProgram = Money.of(
      divide(P.minor * newReleasedInvoice.minor, I.minor, 'FLOOR'),
      P.currency.code,
    );
    const freedProgram = newReleasedProgram.subtract(releasedProgram);

    this.state = {
      ...this.state,
      releasedInvoice: newReleasedInvoice,
      releasedProgram: newReleasedProgram,
      status: newReleasedInvoice.equals(I) ? 'RELEASED' : 'PARTIALLY_RELEASED',
    };
    return { releasedInvoice: requested, freedProgram };
  }
}
