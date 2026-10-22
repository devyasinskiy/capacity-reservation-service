import { DomainError } from '../errors/domain-error';
import { type Currency, currency as toCurrency } from './currency';

// Postgres bigint range; anything outside cannot be persisted.
const INT64_MAX = 2n ** 63n - 1n;
const INT64_MIN = -(2n ** 63n);
const INTEGER = /^-?\d{1,19}$/;

/** Immutable amount in integer minor units of one currency. Never a float (ADR-002). */
export class Money {
  private constructor(
    readonly minor: bigint,
    readonly currency: Currency,
  ) {}

  /**
   * Creates an amount from integer minor units.
   * @throws DomainError `AMOUNT_OUT_OF_RANGE` outside the Postgres bigint range.
   * @throws DomainError `CURRENCY_NOT_SUPPORTED` for an unknown currency code.
   */
  static of(minor: bigint, code: string): Money {
    if (minor > INT64_MAX || minor < INT64_MIN) {
      throw new DomainError('AMOUNT_OUT_OF_RANGE', 'Amount exceeds the supported range');
    }
    return new Money(minor, toCurrency(code));
  }

  /** Zero in the given currency. */
  static zero(code: string): Money {
    return Money.of(0n, code);
  }

  /** Parses the API/wire representation: an integer string of minor units. */
  static parse(amountMinor: string, code: string): Money {
    if (!INTEGER.test(amountMinor)) {
      throw new DomainError(
        'INVALID_AMOUNT',
        'amountMinor must be an integer string of minor units',
      );
    }
    return Money.of(BigInt(amountMinor), code);
  }

  /** Sum of two amounts. @throws DomainError `CURRENCY_MISMATCH` if currencies differ. */
  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.minor + other.minor, this.currency.code);
  }

  /** Difference `this − other`. @throws DomainError `CURRENCY_MISMATCH` if currencies differ. */
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.minor - other.minor, this.currency.code);
  }

  /** True if strictly greater than zero. */
  isPositive(): boolean {
    return this.minor > 0n;
  }

  /** True if strictly less than zero. */
  isNegative(): boolean {
    return this.minor < 0n;
  }

  /** True if exactly zero. */
  isZero(): boolean {
    return this.minor === 0n;
  }

  /** Strict comparison. @throws DomainError `CURRENCY_MISMATCH` if currencies differ. */
  greaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor > other.minor;
  }

  /** Value equality: same currency and same minor amount (never throws). */
  equals(other: Money): boolean {
    return this.currency.code === other.currency.code && this.minor === other.minor;
  }

  /** True if this amount is denominated in `code`. */
  hasCurrency(code: string): boolean {
    return this.currency.code === code;
  }

  /** Wire representation: minor units as a string so bigint survives JSON (ADR-002). */
  toJSON(): { amountMinor: string; currency: string } {
    return { amountMinor: this.minor.toString(), currency: this.currency.code };
  }

  /** Debug/log representation; not for display to end users. */
  toString(): string {
    return `${this.minor.toString()} ${this.currency.code} (minor)`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency.code !== this.currency.code) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        `Cannot combine ${this.currency.code} with ${other.currency.code}`,
        { expected: this.currency.code, actual: other.currency.code },
      );
    }
  }
}
