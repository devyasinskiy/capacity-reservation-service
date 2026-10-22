import fc from 'fast-check';
import { DomainError } from '../../../shared/errors/domain-error';
import { FxRate } from '../../../shared/money/fx-rate';
import { Money } from '../../../shared/money/money';
import { Program } from './program';
import type { Reservation } from './reservation';

const now = new Date('2026-10-11T12:00:00Z');
const usd = (m: bigint) => Money.of(m, 'USD');
const identity = FxRate.identity('USD', now);
const eurUsd = FxRate.of({ base: 'EUR', quote: 'USD', rate: '1.0825', source: 'TEST', asOf: now });

const openProgram = (limit: bigint) =>
  Program.open({ tenantId: 't-1', programId: 'p-1', limit: usd(limit), version: 1n }).program;

let seq = 0;
const reserve = (p: Program, amount: Money, fxRate = identity) =>
  p.reserve({
    reservationId: `r-${++seq}`,
    invoiceId: `inv-${seq}`,
    invoiceAmount: amount,
    fxRate,
    now,
  });

const errorCode = (fn: () => unknown) => {
  try {
    fn();
    return 'NO_ERROR';
  } catch (e) {
    return e instanceof DomainError ? e.code : String(e);
  }
};

describe('Program', () => {
  it('opens with zero reserved and a LIMIT_SET movement', () => {
    const { program, movement } = Program.open({
      tenantId: 't-1',
      programId: 'p-1',
      limit: usd(1000n),
      version: 5n,
    });
    expect(program.available.minor).toBe(1000n);
    expect(movement).toEqual({
      type: 'LIMIT_SET',
      reservationId: null,
      reservedDelta: 0n,
      limitAfter: 1000n,
      reservedAfter: 0n,
    });
  });

  describe('reserve', () => {
    it('reserves up to and including the exact limit', () => {
      const p = openProgram(1000n);
      const { reservation, movement } = reserve(p, usd(600n));
      expect(movement).toEqual({
        type: 'RESERVE',
        reservationId: reservation.id,
        reservedDelta: 600n,
        limitAfter: 1000n,
        reservedAfter: 600n,
      });
      reserve(p, usd(400n));
      expect(p.available.isZero()).toBe(true);
    });

    it('rejects a reservation exceeding available capacity, leaving state unchanged', () => {
      const p = openProgram(1000n);
      reserve(p, usd(600n));
      expect(errorCode(() => reserve(p, usd(401n)))).toBe('INSUFFICIENT_CAPACITY');
      expect(p.reserved.minor).toBe(600n);
    });

    it('converts invoice currency with CEIL and locks rate, source and timestamp', () => {
      const p = openProgram(1_000_000n);
      // 0.01 EUR × 1.0825 = 1.0825 cents → 2 cents (CEIL)
      const { reservation } = reserve(p, Money.of(1n, 'EUR'), eurUsd);
      expect(reservation.programAmount).toEqual(usd(2n));
      expect(reservation.toState().fx).toEqual({ rate: '1.0825', source: 'TEST', asOf: now });
      expect(p.reserved.minor).toBe(2n);
    });

    it('checks capacity against the converted amount', () => {
      const p = openProgram(10824n);
      expect(errorCode(() => reserve(p, Money.of(10000n, 'EUR'), eurUsd))).toBe(
        'INSUFFICIENT_CAPACITY',
      );
      expect(errorCode(() => reserve(openProgram(10825n), Money.of(10000n, 'EUR'), eurUsd))).toBe(
        'NO_ERROR',
      );
    });

    it('rejects a rate that does not match invoice → program currencies', () => {
      expect(errorCode(() => reserve(openProgram(1000n), Money.of(1n, 'GBP'), eurUsd))).toBe(
        'CURRENCY_MISMATCH',
      );
      const eurGbp = FxRate.of({ base: 'EUR', quote: 'GBP', rate: '0.85', source: 'T', asOf: now });
      expect(errorCode(() => reserve(openProgram(1000n), Money.of(1n, 'EUR'), eurGbp))).toBe(
        'CURRENCY_MISMATCH',
      );
    });

    it.each([0n, -5n])('rejects non-positive amount %p', (m) => {
      expect(errorCode(() => reserve(openProgram(1000n), usd(m)))).toBe('INVALID_AMOUNT');
    });
  });

  describe('release', () => {
    it('returns the locked program amount and records a negative delta', () => {
      const p = openProgram(1_000_000n);
      const { reservation } = reserve(p, Money.of(10000n, 'EUR'), eurUsd);
      const out = p.release(reservation);
      expect(out.freedProgram).toEqual(usd(10825n));
      expect(out.movement).toMatchObject({
        type: 'RELEASE',
        reservedDelta: -10825n,
        reservedAfter: 0n,
      });
    });

    it('refuses to release a reservation of another program', () => {
      const a = openProgram(1000n);
      const b = Program.open({
        tenantId: 't-1',
        programId: 'p-2',
        limit: usd(1000n),
        version: 1n,
      }).program;
      const { reservation } = reserve(a, usd(10n));
      expect(() => b.release(reservation)).toThrow(/does not belong/);
    });
  });

  describe('external reservations (ADR-013)', () => {
    it('are accepted beyond the limit and flip the program over limit', () => {
      const p = openProgram(100n);
      const { movement } = p.applyExternalReservation({
        reservationId: 'x-1',
        externalRef: 'T-1',
        invoiceId: 'inv-x',
        amount: usd(150n),
        occurredAt: now,
      });
      expect(movement).toMatchObject({ type: 'EXTERNAL_RESERVE', reservedDelta: 150n });
      expect(p.available.minor).toBe(-50n);
      expect(p.overLimit).toBe(true);
      expect(errorCode(() => reserve(p, usd(1n)))).toBe('INSUFFICIENT_CAPACITY');
    });

    it('must be in program currency', () => {
      expect(
        errorCode(() =>
          openProgram(100n).applyExternalReservation({
            reservationId: 'x',
            externalRef: 'T',
            invoiceId: 'i',
            amount: Money.of(1n, 'EUR'),
            occurredAt: now,
          }),
        ),
      ).toBe('CURRENCY_MISMATCH');
    });

    it('release as EXTERNAL_RELEASE movements', () => {
      const p = openProgram(100n);
      const { reservation } = p.applyExternalReservation({
        reservationId: 'x',
        externalRef: 'T',
        invoiceId: 'i',
        amount: usd(80n),
        occurredAt: now,
      });
      expect(p.release(reservation, usd(30n)).movement).toMatchObject({
        type: 'EXTERNAL_RELEASE',
        reservedDelta: -30n,
      });
      expect(p.reserved.minor).toBe(50n);
    });
  });

  describe('limits and watermarks (ADR-010)', () => {
    it('applies a newer limit, ignores stale or equal versions', () => {
      const p = openProgram(1000n); // version 1
      expect(p.setLimit(usd(500n), 1n)).toEqual({ applied: false });
      const out = p.setLimit(usd(500n), 2n);
      expect(out.applied && out.movement).toMatchObject({ type: 'LIMIT_SET', limitAfter: 500n });
      expect(p.setLimit(usd(9n), 1n).applied).toBe(false);
      expect(p.limit.minor).toBe(500n);
    });

    it('accepts a limit below reserved (over limit) without touching reservations', () => {
      const p = openProgram(1000n);
      reserve(p, usd(800n));
      p.setLimit(usd(500n), 2n);
      expect(p.reserved.minor).toBe(800n);
      expect(p.overLimit).toBe(true);
    });

    it('never changes program currency', () => {
      expect(errorCode(() => openProgram(1000n).setLimit(Money.of(1n, 'EUR'), 9n))).toBe(
        'CURRENCY_MISMATCH',
      );
    });

    it('an older snapshot completing later does not roll back a newer LIMIT_SET', () => {
      const p = openProgram(1000n);
      p.setLimit(usd(2000n), 11n); // LIMIT_SET v11 applied while snapshot v10 was staging
      const out = p.applySnapshot(usd(1500n), 10n);
      expect(out.applied).toBe(false);
      expect(p.limit.minor).toBe(2000n);
      expect(p.isSnapshotStale(10n)).toBe(true);
    });

    it('a newer snapshot applies its limit and advances both watermarks', () => {
      const p = openProgram(1000n);
      expect(p.applySnapshot(usd(1500n), 12n).applied).toBe(true);
      expect(p.limit.minor).toBe(1500n);
      expect(p.setLimit(usd(1n), 12n).applied).toBe(false);
      expect(() => p.applySnapshot(usd(1n), 12n)).toThrow(/not newer/);
    });
  });

  it('local reservations never exceed the limit and reserved = Σ deltas (property)', () => {
    type Op =
      { kind: 'reserve'; amount: bigint } | { kind: 'release'; pick: number; fraction: number };
    const op = fc.oneof(
      fc.record({ kind: fc.constant('reserve' as const), amount: fc.bigInt(1n, 400n) }),
      fc.record({
        kind: fc.constant('release' as const),
        pick: fc.nat(),
        fraction: fc.integer({ min: 1, max: 4 }),
      }),
    );
    fc.assert(
      fc.property(fc.bigInt(0n, 2000n), fc.array(op, { maxLength: 60 }), (limit, ops: Op[]) => {
        const p = openProgram(limit);
        const live: Reservation[] = [];
        let sumDeltas = 0n;
        for (const o of ops) {
          if (o.kind === 'reserve') {
            try {
              const { reservation, movement } = reserve(p, usd(o.amount));
              live.push(reservation);
              sumDeltas += movement.reservedDelta;
            } catch (e) {
              expect((e as DomainError).code).toBe('INSUFFICIENT_CAPACITY');
            }
          } else if (live.length > 0) {
            const r = live[o.pick % live.length]!;
            const part = r.outstandingInvoice.minor / BigInt(o.fraction);
            const { movement } = p.release(r, part > 0n ? usd(part) : undefined);
            sumDeltas += movement.reservedDelta;
            if (r.status === 'RELEASED') live.splice(live.indexOf(r), 1);
          }
          expect(p.reserved.minor <= p.limit.minor).toBe(true);
          expect(p.reserved.minor >= 0n).toBe(true);
          expect(p.reserved.minor).toBe(sumDeltas);
        }
      }),
    );
  });
});
