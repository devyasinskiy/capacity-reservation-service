import { Kysely, PostgresDialect } from 'kysely';
import { type CustomTypesConfig, Pool, types } from 'pg';
import type { Database } from './database.types';

/** DI token for the app-wide `Kysely<Database>` instance. */
export const KYSELY = Symbol('Kysely');

const INT8_OID = 20;

/**
 * Per-pool type parsing (not the global `pg.types`): int8 → bigint so money never passes
 * through a JS number (ADR-002). numeric (FX rates) is left as an exact string.
 */
const parseInt8 = (value: string): bigint => BigInt(value);
// pg-types' TypeParser is typed with `any` output; narrowed to `unknown` here.
// eslint-disable-next-line @typescript-eslint/no-unsafe-return
const defaultParser = (oid: number): ((value: string) => unknown) => types.getTypeParser(oid);

const typeParser: CustomTypesConfig = {
  getTypeParser: ((oid: number) =>
    oid === INT8_OID ? parseInt8 : defaultParser(oid)) as CustomTypesConfig['getTypeParser'],
};

/** Pool tuning for {@link createDatabase}. */
export interface DatabaseOptions {
  readonly poolMax?: number;
  readonly applicationName?: string;
  /** Max wait for a free pooled connection; pg's default (0) waits forever under overload. */
  readonly acquireTimeoutMs?: number;
  /** Errors on *idle* pooled connections (e.g. DB restart/failover). */
  readonly onPoolError?: (error: Error) => void;
}

/**
 * Builds a Kysely instance over a dedicated pg pool with bigint-safe int8 parsing.
 * @param url Postgres connection string.
 * @param options Pool size, acquire timeout and idle-error handler.
 */
export function createDatabase(url: string, options: DatabaseOptions = {}): Kysely<Database> {
  const pool = new Pool({
    connectionString: url,
    max: options.poolMax ?? 10,
    application_name: options.applicationName ?? 'program-capacity',
    connectionTimeoutMillis: options.acquireTimeoutMs ?? 3000,
    types: typeParser,
  });
  // Without a listener, a server-side disconnect of an idle client is an unhandled 'error' event
  // and kills the process. The pool discards the broken client and reconnects on next checkout.
  pool.on('error', (error) => (options.onPoolError ?? defaultPoolErrorHandler)(error));
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

function defaultPoolErrorHandler(error: Error): void {
  console.error(
    JSON.stringify({ level: 'error', msg: 'Idle database connection error', err: error.message }),
  );
}
