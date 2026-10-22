import fc from 'fast-check';
import { DomainError } from '../../../shared/errors/domain-error';
import { Money } from '../../../shared/money/money';
import { Reservation } from './reservation';

const make = (invoiceMinor: bigint, programMinor: bigint, invoiceCcy = 'EUR', programCcy = 'USD') =>
  Reservation.open({
    id: 'r-1',
    tenantId: 't-1',
    programId: 'p-1',
    invoiceId: 'inv-1',
    origin: 'LOCAL',
    externalRef: null,
    invoiceAmount: Money.of(invoiceMinor, invoiceCcy),
    programAmount: Money.of(programMinor, programCcy),
    fx: { rate: '1.0825', source: 'TEST', asOf: new Date(0) },
    createdAt: new Date(0),
  });

const eur = (m: bigint) => Money.of(m, 'EUR');
const errorCode = (fn: () => unknown) => {
  try {
    fn();
    return 'NO_ERROR';
  } catch (e) {
    return (e as DomainError).code;
  }
};

describe('Reservation.release (ADR-004)', () => {
  it('releases the whole remainder when no amount is given', () => {
    const r = make(10000n, 10825n);
    expect(r.release().freedProgram.minor).toBe(10825n);
    expect(r.status).toBe('RELEASED');
    expect(r.outstandingProgram.isZero()).toBe(true);
  });

  it('frees pro-rata with cumulative FLOOR and frees the exact remainder last (P=1001, I=3)', () => {
    const r = make(3n, 1001n);
    expect(r.release(eur(1n)).freedProgram.minor).toBe(333n);
    expect(r.status).toBe('PARTIALLY_RELEASED');
    expect(r.release(eur(1n)).freedProgram.minor).toBe(334n);
    expect(r.release(eur(1n)).freedProgram.minor).toBe(334n);
    expect(r.status).toBe('RELEASED');
  });

  it('can free zero capacity for a tiny slice (conservative) and still total exactly', () => {
    const r = make(1000n, 1n);
    expect(r.release(eur(1n)).freedProgram.minor).toBe(0n);
    expect(r.release(eur(999n)).freedProgram.minor).toBe(1n);
  });

  it('rejects over-release without changing state', () => {
    const r = make(100n, 108n);
    r.release(eur(60n));
    expect(errorCode(() => r.release(eur(41n)))).toBe('OVER_RELEASE');
    expect(r.outstandingInvoice.minor).toBe(40n);
  });

  it('rejects release in a currency other than the invoice currency', () => {
    expect(errorCode(() => make(100n, 108n).release(Money.of(10n, 'USD')))).toBe(
      'CURRENCY_MISMATCH',
    );
  });

  it.each([0n, -1n])('rejects non-positive amount %p', (m) => {
    expect(errorCode(() => make(100n, 108n).release(eur(m)))).toBe('INVALID_AMOUNT');
  });

  it('rejects any release after full release', () => {
    const r = make(100n, 108n);
    r.release();
    expect(errorCode(() => r.release())).toBe('RESERVATION_ALREADY_RELEASED');
    expect(errorCode(() => r.release(eur(1n)))).toBe('RESERVATION_ALREADY_RELEASED');
  });

  it('any partition of I frees exactly P in total and never frees early (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt(1n, 10n ** 12n),
        fc.bigInt(0n, 10n ** 12n),
        fc.array(fc.bigInt(1n, 10n ** 6n), { minLength: 1, maxLength: 20 }),
        (I, P, weights) => {
          // Split I into positive slices proportional to weights (last slice takes the rest).
          const totalW = weights.reduce((a, b) => a + b, 0n);
          const slices: bigint[] = [];
          let left = I;
          for (const w of weights.slice(0, -1)) {
            const s = (I * w) / totalW;
            if (s > 0n && s < left) {
              slices.push(s);
              left -= s;
            }
          }
          slices.push(left);

          const r = make(I, P);
          let releasedI = 0n;
          let freedP = 0n;
          for (const s of slices) {
            const { freedProgram } = r.release(eur(s));
            expect(freedProgram.minor >= 0n).toBe(true);
            releasedI += s;
            freedP += freedProgram.minor;
            // never ahead of the exact pro-rata share: freedP ≤ P × releasedI / I
            expect(freedP * I <= P * releasedI).toBe(true);
          }
          expect(freedP).toBe(P);
          expect(r.status).toBe('RELEASED');
        },
      ),
    );
  });
});
