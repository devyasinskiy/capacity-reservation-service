/** Exact integer division with an explicit rounding direction. `d` must be positive. */
export type Rounding = 'FLOOR' | 'CEIL';

/**
 * Divides `n / d` rounding toward −∞ (FLOOR) or +∞ (CEIL).
 * @throws RangeError if `d` is not positive.
 */
export function divide(n: bigint, d: bigint, rounding: Rounding): bigint {
  if (d <= 0n) throw new RangeError('divisor must be positive');
  // BigInt division truncates toward zero; adjust to floor/ceil explicitly.
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  if (rounding === 'FLOOR') return n < 0n ? q - 1n : q;
  return n > 0n ? q + 1n : q;
}

/** `10^exp` as a bigint. */
export function pow10(exp: number): bigint {
  return 10n ** BigInt(exp);
}
