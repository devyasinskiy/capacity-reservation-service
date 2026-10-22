/**
 * Business-rule violations raised by the domain. Framework-free: the HTTP status mapping lives
 * in the delivery layer (ProblemDetailsFilter), the Kafka mapping in the consumer (ADR-015).
 */
export type DomainErrorCode =
  | 'INVALID_AMOUNT'
  | 'AMOUNT_OUT_OF_RANGE'
  | 'CURRENCY_NOT_SUPPORTED'
  | 'CURRENCY_MISMATCH'
  | 'FX_RATE_UNAVAILABLE'
  | 'INSUFFICIENT_CAPACITY'
  | 'OVER_RELEASE'
  | 'RESERVATION_ALREADY_RELEASED'
  | 'RESERVATION_CONFLICT'
  | 'PROGRAM_NOT_FOUND'
  | 'RESERVATION_NOT_FOUND'
  | 'RESERVATION_MANAGED_EXTERNALLY'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'INVALID_CURSOR'
  | 'SNAPSHOT_INCONSISTENT';

/** Expected business-rule failure carrying a stable `code`; safe to surface to clients. */
export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    /** Client-safe context only (strings, never bigint). */
    readonly details?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
