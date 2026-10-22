import { DomainError } from '../errors/domain-error';
import { type Currency, currency as toCurrency } from './currency';
import { Money } from './money';
import { divide, pow10, type Rounding } from './rational';

const MAX_SCALE = 12; // matches numeric(30,12) storage
const DECIMAL = new RegExp(`^(\\d{1,18})(?:\\.(\\d{1,${MAX_SCALE}}))?$`);

/**
 * A quoted FX rate: `rate` units of `quote` per 1 unit of `base` (major units), e.g.
 * base=EUR, quote=USD, rate="1.0825". Held as an exact decimal string, never a float (ADR-003).
 */
export class FxRate {
  private constructor(
    readonly base: Currency,
    readonly quote: Currency,
    readonly rate: string,
    private readonly numerator: bigint,
    private readonly denominator: bigint,
    readonly source: string,
    readonly asOf: Date,
  ) {}

  /**
   * Parses a quoted rate. `rate` must be a positive decimal string (≤ 12 fractional digits).
   * @throws DomainError `FX_RATE_UNAVAILABLE` if the rate is malformed or zero.
   * @throws DomainError `CURRENCY_NOT_SUPPORTED` for an unknown base/quote currency.
   */
  static of(params: {
    base: string;
    quote: string;
    rate: string;
    source: string;
    asOf: Date;
  }): FxRate {
    const match = DECIMAL.exec(params.rate);
    if (!match) {
      throw new DomainError('FX_RATE_UNAVAILABLE', `Malformed FX rate "${params.rate}"`);
    }
    const intPart = match[1] ?? '0';
    const fracPart = match[2] ?? '';
    const numerator = BigInt(intPart + fracPart);
    if (numerator === 0n) throw new DomainError('FX_RATE_UNAVAILABLE', 'FX rate must be positive');
    return new FxRate(
      toCurrency(params.base),
      toCurrency(params.quote),
      params.rate,
      numerator,
      pow10(fracPart.length),
      params.source,
      params.asOf,
    );
  }

  /** Same-currency "conversion": exact, no rounding. */
  static identity(code: string, asOf: Date, source = 'IDENTITY'): FxRate {
    return FxRate.of({ base: code, quote: code, rate: '1', source, asOf });
  }

  /** True when base and quote are the same currency (conversion is a no-op). */
  isIdentity(): boolean {
    return this.base.code === this.quote.code;
  }

  /** True if the quote is no older than `maxAgeMs` at `now` (ADR-003). */
  isFresh(now: Date, maxAgeMs: number): boolean {
    return now.getTime() - this.asOf.getTime() <= maxAgeMs;
  }

  /**
   * Converts `money` (in base) to quote minor units with exact rational arithmetic:
   *   out = minor × num × 10^quoteExp / (den × 10^baseExp), rounded as requested.
   */
  convert(money: Money, rounding: Rounding): Money {
    if (!money.hasCurrency(this.base.code)) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        `Rate base is ${this.base.code}, amount is ${money.currency.code}`,
      );
    }
    if (this.isIdentity()) return money;
    const n = money.minor * this.numerator * pow10(this.quote.exponent);
    const d = this.denominator * pow10(this.base.exponent);
    return Money.of(divide(n, d, rounding), this.quote.code);
  }
}
