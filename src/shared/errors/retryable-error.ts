/**
 * Transient infrastructure failure (lock timeout, statement timeout, connection loss). Safe for
 * the caller to retry: HTTP maps it to 503 + Retry-After (ADR-005), Kafka retries with backoff
 * (ADR-012). The message is for logs only and never reaches clients.
 */
export class RetryableError extends Error {
  constructor(
    message: string,
    readonly reason: 'LOCK_TIMEOUT' | 'STATEMENT_TIMEOUT' | 'CONNECTION' | 'SERIALIZATION',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'RetryableError';
  }
}
