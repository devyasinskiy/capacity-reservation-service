import { isSupportedCurrency } from '../../../../shared/money/currency';
import { FxRate } from '../../../../shared/money/fx-rate';
import { divide, pow10 } from '../../../../shared/money/rational';
import type { Clock } from '../../application/ports/clock';
import type { FxRateProvider } from '../../application/ports/fx-rate-provider';

/** Static USD value of one unit of each currency. Illustrative numbers, not market data. */
export const STUB_USD_PER_UNIT: Readonly<Record<string, string>> = {
  USD: '1',
  EUR: '1.0825',
  GBP: '1.2710',
  CHF: '1.1150',
  JPY: '0.006650',
  KWD: '3.2550',
};

const SCALE = 12;

/**
 * Deterministic stub (ADR-003): cross rates derived from a USD table, quoted to 12 decimal
 * places (rounded half-up — the *quote* is the provider's business; once quoted, the decimal
 * string is locked and used exactly). Rates are always "fresh" (asOf = now).
 */
export class StubFxRateProvider implements FxRateProvider {
  constructor(
    private readonly clock: Clock,
    private readonly table: Readonly<Record<string, string>> = STUB_USD_PER_UNIT,
  ) {}

  /** Cross rate `base → quote` via USD, or null if either currency is not in the table. */
  getRate(base: string, quote: string): Promise<FxRate | null> {
    const now = this.clock.now();
    if (base === quote) return Promise.resolve(FxRate.identity(base, now));
    const b = this.table[base];
    const q = this.table[quote];
    if (!b || !q || !isSupportedCurrency(base) || !isSupportedCurrency(quote))
      return Promise.resolve(null);
    return Promise.resolve(
      FxRate.of({ base, quote, rate: crossRate(b, q), source: 'STUB', asOf: now }),
    );
  }
}

/** (usdPerBase / usdPerQuote) as a decimal string with SCALE places, half-up. */
function crossRate(usdPerBase: string, usdPerQuote: string): string {
  const [bn, bd] = toFraction(usdPerBase);
  const [qn, qd] = toFraction(usdPerQuote);
  const scaled = divide(bn * qd * pow10(SCALE) * 2n + qn * bd, qn * bd * 2n, 'FLOOR');
  const digits = scaled.toString().padStart(SCALE + 1, '0');
  const int = digits.slice(0, -SCALE);
  const frac = digits.slice(-SCALE).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

function toFraction(decimal: string): [bigint, bigint] {
  const [int = '0', frac = ''] = decimal.split('.');
  return [BigInt(int + frac), pow10(frac.length)];
}
