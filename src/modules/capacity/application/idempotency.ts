import { createHash } from 'node:crypto';
import { DomainError } from '../../../shared/errors/domain-error';

/** What we store per key: enough to replay the original response byte-for-byte (ADR-006). */
export interface IdempotencyRecord {
  readonly key: string;
  readonly operation: 'RESERVE' | 'RELEASE';
  readonly requestHash: string;
  readonly responseStatus: number;
  readonly responseBody: unknown;
}

/** Outcome of an idempotent write: the HTTP status and body to return. */
export interface IdempotentResult<T> {
  readonly status: number;
  readonly body: T;
  /** True when served from a stored record or an equivalent existing reservation. */
  readonly replayed: boolean;
}

/** Hash of the semantically relevant request: same key + different request is a client bug. */
export function requestHash(parts: Record<string, string | null | undefined>): string {
  const canonical = JSON.stringify(
    Object.keys(parts)
      .sort()
      .map((k) => [k, parts[k] ?? null]),
  );
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Replays a stored response if it belongs to the same operation and request.
 * @throws DomainError `IDEMPOTENCY_KEY_REUSED` if the key was used for a different request.
 */
export function replayOrReject<T>(
  record: IdempotencyRecord,
  operation: string,
  hash: string,
): IdempotentResult<T> {
  if (record.operation !== operation || record.requestHash !== hash) {
    throw new DomainError(
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used for a different request',
    );
  }
  return { status: record.responseStatus, body: record.responseBody as T, replayed: true };
}

/** Thrown by the store when a concurrent request committed the same key first. */
export class IdempotencyKeyRace extends Error {
  constructor() {
    super('Idempotency key inserted concurrently');
    this.name = 'IdempotencyKeyRace';
  }
}
