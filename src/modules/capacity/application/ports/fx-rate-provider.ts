import type { FxRate } from '../../../../shared/money/fx-rate';

/**
 * Source of FX quotes (ADR-003). Returns null when no rate is available for the pair; the
 * caller decides how to fail (FX_RATE_UNAVAILABLE) and enforces freshness.
 * The stub implementation is local; a real provider would do network I/O, which is why rates
 * are resolved *before* the program lock is taken (ADR-005).
 */
export interface FxRateProvider {
  /** Latest quote for `base → quote`, or null if the pair is unavailable. */
  getRate(base: string, quote: string): Promise<FxRate | null>;
}

/** DI token for {@link FxRateProvider}. */
export const FX_RATE_PROVIDER = Symbol('FxRateProvider');
