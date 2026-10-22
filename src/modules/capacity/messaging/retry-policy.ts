import { DomainError } from '../../../shared/errors/domain-error';
import { RetryableError } from '../../../shared/errors/retryable-error';
import { InvalidTreasuryMessageError } from './treasury-message.schema';

/** Retry budget for transient failures before dead-lettering (ADR-012). */
export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
}

/** Whether a failure is worth retrying, plus the code reported in metrics and DLQ headers. */
export type FailureClass = { retryable: false; code: string } | { retryable: true; code: string };

/**
 * ADR-012: retrying cannot fix malformed input or a business-rule violation, so those go to the
 * DLQ immediately. Infrastructure failures (and unknown errors, which may be transient) are
 * retried with backoff, then dead-lettered so the partition is never blocked forever.
 */
export function classifyFailure(error: unknown): FailureClass {
  if (error instanceof InvalidTreasuryMessageError)
    return { retryable: false, code: 'INVALID_MESSAGE' };
  if (error instanceof DomainError) return { retryable: false, code: error.code };
  if (error instanceof RetryableError)
    return { retryable: true, code: `TRANSIENT_${error.reason}` };
  return { retryable: true, code: 'UNEXPECTED_ERROR' };
}

/** Exponential backoff with full jitter: random in [0, min(max, initial × 2^(attempt-1))]. */
export function backoffDelay(
  policy: RetryPolicy,
  attempt: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (attempt - 1));
  return Math.round(random() * ceiling);
}
