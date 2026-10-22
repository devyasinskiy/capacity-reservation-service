import { DomainError } from '../errors/domain-error';
import { currency } from './currency';
import { Money } from './money';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof DomainError ? e.code : 'NOT_A_DOMAIN_ERROR';
  }
  return 'NO_ERROR';
};

describe('currency', () => {
  it('knows exponents of supported currencies', () => {
    expect(currency('USD').exponent).toBe(2);
    expect(currency('JPY').exponent).toBe(0);
    expect(currency('KWD').exponent).toBe(3);
  });

  it.each(['XXX', 'usd', '', 'toString', '__proto__'])('rejects %p', (c) => {
    expect(code(() => currency(c))).toBe('CURRENCY_NOT_SUPPORTED');
  });
});

describe('Money', () => {
  it('parses integer minor-unit strings', () => {
    expect(Money.parse('123456', 'USD').minor).toBe(123456n);
    expect(Money.parse('-5', 'JPY').minor).toBe(-5n);
  });

  it.each(['1.5', '1e3', '', ' 1', '0x10', '12345678901234567890'])(
    'rejects malformed amount %p',
    (s) => {
      expect(code(() => Money.parse(s, 'USD'))).toMatch(/INVALID_AMOUNT|AMOUNT_OUT_OF_RANGE/);
    },
  );

  it('enforces the Postgres bigint range', () => {
    expect(Money.of(2n ** 63n - 1n, 'USD').minor).toBe(2n ** 63n - 1n);
    expect(code(() => Money.of(2n ** 63n, 'USD'))).toBe('AMOUNT_OUT_OF_RANGE');
    expect(code(() => Money.of(2n ** 63n - 1n, 'USD').add(Money.of(1n, 'USD')))).toBe(
      'AMOUNT_OUT_OF_RANGE',
    );
  });

  it('does arithmetic only within one currency', () => {
    const a = Money.of(150n, 'USD');
    expect(a.add(Money.of(50n, 'USD')).minor).toBe(200n);
    expect(a.subtract(Money.of(200n, 'USD')).minor).toBe(-50n);
    expect(code(() => a.add(Money.of(1n, 'EUR')))).toBe('CURRENCY_MISMATCH');
    expect(code(() => a.greaterThan(Money.of(1n, 'EUR')))).toBe('CURRENCY_MISMATCH');
  });

  it('serialises amounts as strings, never JSON numbers', () => {
    expect(JSON.stringify(Money.of(9007199254740993n, 'USD'))).toBe(
      '{"amountMinor":"9007199254740993","currency":"USD"}',
    );
  });

  it('compares by currency and amount', () => {
    expect(Money.of(1n, 'USD').equals(Money.of(1n, 'USD'))).toBe(true);
    expect(Money.of(1n, 'USD').equals(Money.of(1n, 'EUR'))).toBe(false);
  });
});
