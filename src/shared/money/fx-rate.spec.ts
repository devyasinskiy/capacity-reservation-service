import fc from 'fast-check';
import { DomainError } from '../errors/domain-error';
import { currency } from './currency';
import { FxRate } from './fx-rate';
import { Money } from './money';
import { pow10 } from './rational';

const asOf = new Date('2026-10-11T12:00:00Z');
const rate = (base: string, quote: string, r: string) =>
  FxRate.of({ base, quote, rate: r, source: 'TEST', asOf });

describe('FxRate', () => {
  it('converts exactly when the result is a whole number of minor units', () => {
    // 100.00 EUR × 1.0825 = 108.25 USD
    expect(rate('EUR', 'USD', '1.0825').convert(Money.of(10000n, 'EUR'), 'CEIL')).toEqual(
      Money.of(10825n, 'USD'),
    );
  });

  it('handles exponent 0 → 2 (JPY → USD)', () => {
    // 1 JPY × 0.00665 = 0.665 USD = 66.5 cents
    const r = rate('JPY', 'USD', '0.00665');
    expect(r.convert(Money.of(100n, 'JPY'), 'CEIL').minor).toBe(67n);
    expect(r.convert(Money.of(100n, 'JPY'), 'FLOOR').minor).toBe(66n);
  });

  it('handles exponent 3 → 2 (KWD → USD)', () => {
    // 1.001 KWD × 3.2550 = 3.2582550 USD → 325.8255 cents
    const r = rate('KWD', 'USD', '3.2550');
    expect(r.convert(Money.of(1001n, 'KWD'), 'CEIL').minor).toBe(326n);
    expect(r.convert(Money.of(1001n, 'KWD'), 'FLOOR').minor).toBe(325n);
  });

  it('handles exponent 2 → 0 (USD → JPY)', () => {
    // 1.00 USD × 150.375939849624 = 150.37… JPY
    expect(
      rate('USD', 'JPY', '150.375939849624').convert(Money.of(100n, 'USD'), 'CEIL').minor,
    ).toBe(151n);
  });

  it('identity conversion is exact and returns the same amount', () => {
    const m = Money.of(12345n, 'GBP');
    expect(FxRate.identity('GBP', asOf).convert(m, 'CEIL')).toBe(m);
  });

  it.each(['0', '0.000', '-1', '1,5', '1.1234567890123', 'abc', ''])(
    'rejects unusable rate %p',
    (r) => {
      expect(() => rate('EUR', 'USD', r)).toThrow(DomainError);
    },
  );

  it('refuses to convert an amount in the wrong currency', () => {
    expect(() => rate('EUR', 'USD', '1.1').convert(Money.of(1n, 'GBP'), 'CEIL')).toThrow(
      /Rate base is EUR/,
    );
  });

  it('reports freshness against a max age', () => {
    const r = rate('EUR', 'USD', '1.1');
    expect(r.isFresh(new Date(asOf.getTime() + 60_000), 60_000)).toBe(true);
    expect(r.isFresh(new Date(asOf.getTime() + 60_001), 60_000)).toBe(false);
  });

  it('CEIL never under-states, is within one minor unit, and overflow is rejected (property)', () => {
    const codes = ['USD', 'EUR', 'JPY', 'KWD'] as const;
    fc.assert(
      fc.property(
        fc.constantFrom(...codes),
        fc.constantFrom(...codes),
        fc.bigInt(1n, 10n ** 12n),
        fc.bigInt(1n, 10n ** 9n),
        fc.integer({ min: 0, max: 8 }),
        (b, q, minor, rateDigits, scale) => {
          const digits = rateDigits.toString().padStart(scale + 1, '0');
          const rateStr =
            scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
          const r = rate(b, q, rateStr);
          const [i, f = ''] = rateStr.split('.');
          const num = BigInt(`${i}${f}`);
          const den = pow10(f.length);
          // exact value = minor × num × 10^qe / (den × 10^be); check out bounds without division
          const lhsScale = num * pow10(currency(q).exponent);
          const rhsScale = den * pow10(currency(b).exponent);
          const exceedsInt64 = minor * lhsScale > (2n ** 63n - 1n) * rhsScale;
          if (exceedsInt64 && b !== q) {
            return expect(() => r.convert(Money.of(minor, b), 'CEIL')).toThrow(/supported range/);
          }
          const out = r.convert(Money.of(minor, b), 'CEIL').minor;
          if (b === q) return expect(out).toBe(minor);
          expect(out * rhsScale >= minor * lhsScale).toBe(true);
          expect((out - 1n) * rhsScale < minor * lhsScale).toBe(true);
        },
      ),
    );
  });
});
