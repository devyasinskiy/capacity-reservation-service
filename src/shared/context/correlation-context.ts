import { AsyncLocalStorage } from 'node:async_hooks';

interface CorrelationStore {
  readonly correlationId: string;
}

/**
 * One correlation context for both entry points (ADR-018): HTTP middleware and the Kafka listener
 * run their work inside `runWithCorrelationId`, and the pino mixin stamps every log line with it —
 * including lines written deep inside use cases that never see a request object.
 */
const storage = new AsyncLocalStorage<CorrelationStore>();

/** Runs `fn` with `correlationId` visible to everything it awaits or schedules. */
export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return storage.run({ correlationId }, fn);
}

/** The correlation ID of the current async context, or `undefined` outside one. */
export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}
