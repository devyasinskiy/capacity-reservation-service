/** Injected time source so domain/application code is deterministic under test. */
export interface Clock {
  /** Current time. */
  now(): Date;
}

/** DI token for {@link Clock}. */
export const CLOCK = Symbol('Clock');
