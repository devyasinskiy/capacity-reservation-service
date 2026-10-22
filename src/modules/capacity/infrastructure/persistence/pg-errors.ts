import { RetryableError } from '../../../../shared/errors/retryable-error';

// https://www.postgresql.org/docs/current/errcodes-appendix.html
const LOCK_NOT_AVAILABLE = '55P03';
const QUERY_CANCELED = '57014'; // statement_timeout
const SERIALIZATION_FAILURE = '40001';
const DEADLOCK_DETECTED = '40P01';
const CONNECTION_CODES = new Set(['08000', '08003', '08006', '57P01', '57P03']);
const NODE_CONNECTION_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

// pg-pool raises a plain Error (no code) when connectionTimeoutMillis elapses.
const POOL_ACQUIRE_TIMEOUT = /timeout exceeded when trying to connect/i;

/** Maps transient Postgres/driver failures to RetryableError; everything else passes through. */
export function translateDbError(error: unknown): unknown {
  if (error instanceof Error && POOL_ACQUIRE_TIMEOUT.test(error.message)) {
    return new RetryableError('No database connection available', 'CONNECTION', { cause: error });
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return error;
  if (code === LOCK_NOT_AVAILABLE)
    return new RetryableError('Program lock wait timed out', 'LOCK_TIMEOUT', { cause: error });
  if (code === QUERY_CANCELED)
    return new RetryableError('Statement timed out', 'STATEMENT_TIMEOUT', { cause: error });
  if (code === SERIALIZATION_FAILURE || code === DEADLOCK_DETECTED) {
    return new RetryableError('Transaction conflict', 'SERIALIZATION', { cause: error });
  }
  if (CONNECTION_CODES.has(code) || NODE_CONNECTION_CODES.has(code)) {
    return new RetryableError('Database unavailable', 'CONNECTION', { cause: error });
  }
  return error;
}
