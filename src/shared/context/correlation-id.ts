import { randomUUID } from 'node:crypto';

/** Request/response header that carries the correlation ID (lower-case, as Node exposes it). */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

// Restrict accepted IDs so a client cannot inject arbitrary content into logs/ledger rows.
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Returns the caller-supplied correlation ID if well-formed, otherwise a fresh UUID. */
export function resolveCorrelationId(candidate: unknown): string {
  const value = Array.isArray(candidate) ? (candidate[0] as unknown) : candidate;
  return typeof value === 'string' && SAFE_ID.test(value) ? value : randomUUID();
}
