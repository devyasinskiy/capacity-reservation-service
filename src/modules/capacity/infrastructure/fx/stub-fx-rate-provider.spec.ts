import { Money } from '../../../../shared/money/money';
import { StubFxRateProvider } from './stub-fx-rate-provider';

const now = new Date('2026-10-11T12:00:00Z');
const provider = new StubFxRateProvider({ now: () => now });

describe('StubFxRateProvider', () => {
  it('returns identity for the same currency', async () => {
    const r = await provider.getRate('USD', 'USD');
    expect(r?.isIdentity()).toBe(true);
    expect(r?.source).toBe('IDENTITY');
  });

  it.each([
    ['EUR', 'USD', '1.0825'],
    ['USD', 'JPY', '150.375939849624'],
    ['GBP', 'EUR', '1.174133949192'],
    ['KWD', 'JPY', '489.473684210526'],
  ])('quotes %s→%s as %s (12dp, half-up; checked with Python Decimal)', async (b, q, expected) => {
    const r = await provider.getRate(b, q);
    expect(r?.rate).toBe(expected);
    expect(r?.source).toBe('STUB');
    expect(r?.asOf).toEqual(now);
  });

  it('returns null for unknown pairs', async () => {
    expect(await provider.getRate('USD', 'XXX')).toBeNull();
  });

  it('produces rates usable for conversion', async () => {
    const r = await provider.getRate('EUR', 'USD');
    expect(r!.convert(Money.of(10000n, 'EUR'), 'CEIL').minor).toBe(10825n);
  });
});
