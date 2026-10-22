import { DomainError } from '../../../shared/errors/domain-error';
import type { FxRate } from '../../../shared/money/fx-rate';
import { Money } from '../../../shared/money/money';
import type { LedgerMovement, MovementType } from './ledger-movement';
import { Reservation } from './reservation';

/** Persisted state of a {@link Program}. */
export interface ProgramState {
  readonly tenantId: string;
  readonly programId: string;
  readonly limit: Money;
  readonly reserved: Money;
  /** Watermark of the last applied absolute limit (LIMIT_SET or snapshot), ADR-010. */
  readonly limitVersion: bigint;
  /** Watermark of the last applied reconciliation snapshot, ADR-010/011. */
  readonly snapshotVersion: bigint;
}

/** Input to {@link Program.reserve} for a client-initiated (LOCAL) reservation. */
export interface ReserveCommand {
  readonly reservationId: string;
  readonly invoiceId: string;
  readonly invoiceAmount: Money;
  /** Pre-resolved outside the lock (ADR-005); base = invoice ccy, quote = program ccy. */
  readonly fxRate: FxRate;
  readonly now: Date;
}

/** Input to {@link Program.applyExternalReservation} for a treasury-reported reservation. */
export interface ExternalReserveCommand {
  readonly reservationId: string;
  readonly externalRef: string;
  readonly invoiceId: string;
  /** Treasury reports external reservations in program currency. */
  readonly amount: Money;
  readonly occurredAt: Date;
}

/** Result of a limit change: the movement if applied, or `applied: false` if stale. */
export type LimitOutcome = { applied: true; movement: LedgerMovement } | { applied: false };

/**
 * Aggregate root for a financing program's capacity. Holds the only rule that matters for
 * over-reservation: a LOCAL reservation must fit under the limit. Callers guarantee exclusive
 * access (row lock, ADR-005); this class is pure and synchronous.
 */
export class Program {
  private constructor(private state: ProgramState) {}

  /** Rehydrates a program from persisted state; no validation. */
  static restore(state: ProgramState): Program {
    return new Program(state);
  }

  /** A program comes into existence from treasury's first LIMIT_SET (assumption A1). */
  static open(params: { tenantId: string; programId: string; limit: Money; version: bigint }): {
    program: Program;
    movement: LedgerMovement;
  } {
    assertNonNegative(params.limit, 'limit');
    const program = new Program({
      tenantId: params.tenantId,
      programId: params.programId,
      limit: params.limit,
      reserved: Money.zero(params.limit.currency.code),
      limitVersion: params.version,
      snapshotVersion: 0n,
    });
    return { program, movement: program.movement('LIMIT_SET', null, 0n) };
  }

  /** Owning tenant. */
  get tenantId(): string {
    return this.state.tenantId;
  }
  /** Program identifier (unique per tenant). */
  get programId(): string {
    return this.state.programId;
  }
  /** Program currency; fixed for the program's lifetime. */
  get currencyCode(): string {
    return this.state.limit.currency.code;
  }
  /** Total credit limit. */
  get limit(): Money {
    return this.state.limit;
  }
  /** Sum of outstanding reservations, in program currency. */
  get reserved(): Money {
    return this.state.reserved;
  }
  /** May be negative when treasury lowers the limit below current usage (ADR-013). */
  get available(): Money {
    return this.state.limit.subtract(this.state.reserved);
  }
  /** True when reserved exceeds the limit (only possible via treasury, ADR-013). */
  get overLimit(): boolean {
    return this.available.isNegative();
  }

  /** Current state for persistence. */
  toState(): ProgramState {
    return this.state;
  }

  /**
   * Reserves capacity for an invoice, converting at the locked FX rate rounded UP (ADR-003).
   * @throws DomainError `INVALID_AMOUNT` if the amount is not positive.
   * @throws DomainError `CURRENCY_MISMATCH` if the rate does not match invoice/program currencies.
   * @throws DomainError `INSUFFICIENT_CAPACITY` if the converted amount does not fit.
   */
  reserve(cmd: ReserveCommand): { reservation: Reservation; movement: LedgerMovement } {
    if (!cmd.invoiceAmount.isPositive()) {
      throw new DomainError('INVALID_AMOUNT', 'Reservation amount must be positive');
    }
    if (
      cmd.fxRate.base.code !== cmd.invoiceAmount.currency.code ||
      cmd.fxRate.quote.code !== this.currencyCode
    ) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        'FX rate does not match invoice/program currencies',
      );
    }

    // CEIL: over-reserving < 1 minor unit is safe; under-reserving could breach the limit (ADR-003).
    const programAmount = cmd.fxRate.convert(cmd.invoiceAmount, 'CEIL');
    const reservedAfter = this.state.reserved.add(programAmount);
    if (reservedAfter.greaterThan(this.state.limit)) {
      throw new DomainError('INSUFFICIENT_CAPACITY', 'Not enough available capacity', {
        requestedMinor: programAmount.minor.toString(),
        availableMinor: this.available.minor.toString(),
        currency: this.currencyCode,
      });
    }

    const reservation = Reservation.open({
      id: cmd.reservationId,
      tenantId: this.state.tenantId,
      programId: this.state.programId,
      invoiceId: cmd.invoiceId,
      origin: 'LOCAL',
      externalRef: null,
      invoiceAmount: cmd.invoiceAmount,
      programAmount,
      fx: { rate: cmd.fxRate.rate, source: cmd.fxRate.source, asOf: cmd.fxRate.asOf },
      createdAt: cmd.now,
    });
    this.state = { ...this.state, reserved: reservedAfter };
    return { reservation, movement: this.movement('RESERVE', reservation.id, programAmount.minor) };
  }

  /**
   * Releases (part of) a reservation and frees its locked program-currency share (ADR-004).
   * @param amount Invoice-currency amount; omitted = the whole remainder.
   * @throws DomainError see {@link Reservation.release}.
   */
  release(
    reservation: Reservation,
    amount?: Money,
  ): { freedProgram: Money; releasedInvoice: Money; movement: LedgerMovement } {
    this.assertOwns(reservation);
    const outcome = reservation.release(amount);
    this.state = { ...this.state, reserved: this.state.reserved.subtract(outcome.freedProgram) };
    this.assertInvariants();
    const type: MovementType =
      reservation.toState().origin === 'EXTERNAL' ? 'EXTERNAL_RELEASE' : 'RELEASE';
    return {
      ...outcome,
      movement: this.movement(type, reservation.id, -outcome.freedProgram.minor),
    };
  }

  /**
   * Treasury-originated reservation: recorded even if it exceeds the limit — treasury is the
   * system of record and reports facts, it does not ask permission (ADR-013).
   */
  applyExternalReservation(cmd: ExternalReserveCommand): {
    reservation: Reservation;
    movement: LedgerMovement;
  } {
    if (!cmd.amount.isPositive()) {
      throw new DomainError('INVALID_AMOUNT', 'External reservation amount must be positive');
    }
    if (!cmd.amount.hasCurrency(this.currencyCode)) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        'External reservations must be in program currency',
        {
          expected: this.currencyCode,
          actual: cmd.amount.currency.code,
        },
      );
    }
    const reservation = Reservation.open({
      id: cmd.reservationId,
      tenantId: this.state.tenantId,
      programId: this.state.programId,
      invoiceId: cmd.invoiceId,
      origin: 'EXTERNAL',
      externalRef: cmd.externalRef,
      invoiceAmount: cmd.amount,
      programAmount: cmd.amount,
      fx: { rate: '1', source: 'TREASURY', asOf: cmd.occurredAt },
      createdAt: cmd.occurredAt,
    });
    this.state = { ...this.state, reserved: this.state.reserved.add(cmd.amount) };
    return {
      reservation,
      movement: this.movement('EXTERNAL_RESERVE', reservation.id, cmd.amount.minor),
    };
  }

  /** Absolute limit from treasury; applied only if newer than the limit watermark (ADR-010). */
  setLimit(limit: Money, version: bigint): LimitOutcome {
    if (!limit.hasCurrency(this.currencyCode)) {
      throw new DomainError('CURRENCY_MISMATCH', 'Program currency cannot change', {
        expected: this.currencyCode,
        actual: limit.currency.code,
      });
    }
    assertNonNegative(limit, 'limit');
    if (version <= this.state.limitVersion) return { applied: false };
    this.state = { ...this.state, limit, limitVersion: version };
    return { applied: true, movement: this.movement('LIMIT_SET', null, 0n) };
  }

  /** True if a snapshot with `version` has already been superseded (ADR-010). */
  isSnapshotStale(version: bigint): boolean {
    return version <= this.state.snapshotVersion;
  }

  /**
   * Applies a complete reconciliation snapshot's program-level effects: advances the snapshot
   * watermark and applies its limit only if newer than the limit watermark — an older snapshot
   * must not roll back a newer LIMIT_SET (ADR-010/011). Reservation-level differences are never
   * applied here; they become discrepancies.
   */
  applySnapshot(limit: Money, version: bigint): LimitOutcome {
    if (this.isSnapshotStale(version)) {
      throw new Error(
        `Snapshot version ${version} is not newer than ${this.state.snapshotVersion}`,
      );
    }
    const outcome = this.setLimit(limit, version);
    this.state = { ...this.state, snapshotVersion: version };
    return outcome;
  }

  private movement(
    type: MovementType,
    reservationId: string | null,
    delta: bigint,
  ): LedgerMovement {
    return {
      type,
      reservationId,
      reservedDelta: delta,
      limitAfter: this.state.limit.minor,
      reservedAfter: this.state.reserved.minor,
    };
  }

  private assertOwns(reservation: Reservation): void {
    if (
      reservation.programId !== this.state.programId ||
      reservation.tenantId !== this.state.tenantId
    ) {
      throw new Error('Reservation does not belong to this program');
    }
  }

  private assertInvariants(): void {
    // Programming-error guard, not a business rule: reserved can never go below zero.
    if (this.state.reserved.isNegative()) throw new Error('Invariant violated: reserved < 0');
  }
}

function assertNonNegative(m: Money, field: string): void {
  if (m.isNegative()) throw new DomainError('INVALID_AMOUNT', `${field} must not be negative`);
}
