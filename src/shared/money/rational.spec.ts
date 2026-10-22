import fc from 'fast-check';
import { divide } from './rational';

describe('divide', () => {
  it.each([
    [7n, 2n, 3n, 4n],
    [6n, 2n, 3n, 3n],
    [-7n, 2n, -4n, -3n],
    [0n, 5n, 0n, 0n],
    [1n, 1000n, 0n, 1n],
  ])('%p / %p → floor %p, ceil %p', (n, d, floor, ceil) => {
    expect(divide(n, d, 'FLOOR')).toBe(floor);
    expect(divide(n, d, 'CEIL')).toBe(ceil);
  });

  it('rejects non-positive divisors', () => {
    expect(() => divide(1n, 0n, 'FLOOR')).toThrow(RangeError);
  });

  it('floor ≤ n/d ≤ ceil, and they differ by at most one (property)', () => {
    fc.assert(
      fc.property(fc.bigInt(-(10n ** 30n), 10n ** 30n), fc.bigInt(1n, 10n ** 20n), (n, d) => {
        const f = divide(n, d, 'FLOOR');
        const c = divide(n, d, 'CEIL');
        expect(f * d <= n).toBe(true);
        expect((f + 1n) * d > n).toBe(true);
        expect(c * d >= n).toBe(true);
        expect((c - 1n) * d < n).toBe(true);
        expect(c - f).toBe(n % d === 0n ? 0n : 1n);
      }),
    );
  });
});
