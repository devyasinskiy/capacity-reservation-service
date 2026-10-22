/**
 * Business metrics port: use cases report outcomes without depending on a metrics library.
 * The Prometheus adapter lives in the observability module; tests use the no-op default.
 */
export interface ReconciliationMetrics {
  readonly limitApplied: boolean;
  readonly uncertain: number;
  readonly pending: number;
  readonly opened: number;
  readonly cleared: number;
}

/** Business outcome counters reported by the use cases. */
export interface CapacityMetrics {
  /** A reserve request finished with `result`. */
  reservation(result: 'created' | 'replayed' | 'insufficient_capacity' | 'rejected'): void;
  /** A release request finished with `result`. */
  release(result: 'released' | 'replayed' | 'rejected'): void;
  /** A treasury message of `type` was handled with `outcome`. */
  treasuryMessage(type: string, outcome: string): void;
  /** A message was dead-lettered with error `code`. */
  deadLetter(code: string): void;
  /** A reconciliation snapshot was applied. */
  reconciliation(run: ReconciliationMetrics): void;
  /** A treasury-driven change pushed the program from within its limit to over it (ADR-013). */
  overLimitTransition(source: 'LIMIT_SET' | 'EXTERNAL_RESERVATION' | 'SNAPSHOT'): void;
}

/** No-op implementation; the default when no metrics adapter is bound (tests, scripts). */
export const NO_METRICS: CapacityMetrics = {
  reservation: () => undefined,
  release: () => undefined,
  treasuryMessage: () => undefined,
  deadLetter: () => undefined,
  reconciliation: () => undefined,
  overLimitTransition: () => undefined,
};

/** DI token for {@link CapacityMetrics}. */
export const CAPACITY_METRICS = Symbol('CapacityMetrics');
