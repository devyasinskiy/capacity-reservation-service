import { z } from 'zod';

/**
 * Single source of truth for runtime configuration. Validated once at boot so the
 * process fails fast on misconfiguration instead of at first use.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MANAGEMENT_PORT: z.coerce.number().int().min(1).max(65535).default(9464),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  // Bounded wait for a pooled connection → 503 instead of an unbounded queue (ADR-005).
  DB_POOL_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(3000),
  // Bounded lock waits keep a hot program from piling up requests (ADR-005).
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().min(50).max(60_000).default(2000),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(5000),
  KAFKA_BROKERS: z
    .string()
    .min(1)
    .transform((v) =>
      v
        .split(',')
        .map((b) => b.trim())
        .filter((b) => b.length > 0),
    ),
  // RS256 verification key (PEM). Production would use a JWKS endpoint instead (ADR-007).
  KAFKA_CLIENT_ID: z.string().min(1).default('program-capacity'),
  KAFKA_GROUP_ID: z.string().min(1).default('program-capacity'),
  KAFKA_TREASURY_TOPIC: z.string().min(1).default('treasury.capacity.v1'),
  KAFKA_DLQ_TOPIC: z.string().min(1).default('treasury.capacity.v1.dlq'),
  // Lets HTTP-only instances (and the HTTP e2e suite) run without a consumer.
  KAFKA_CONSUMER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  KAFKA_PARTITIONS_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  // Retry with backoff, then DLQ (ADR-012).
  KAFKA_RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  KAFKA_RETRY_INITIAL_MS: z.coerce.number().int().min(1).max(60_000).default(200),
  KAFKA_RETRY_MAX_MS: z.coerce.number().int().min(1).max(300_000).default(5000),
  // Local changes this close before a snapshot's asOf may not have reached treasury yet:
  // mismatches are UNCERTAIN, not strikes (ADR-011).
  RECONCILIATION_GRACE_WINDOW_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),
  // Incomplete chunked snapshots are discarded after this long (ADR-020).
  SNAPSHOT_STAGING_TTL_SECONDS: z.coerce.number().int().min(10).max(86_400).default(900),
  SNAPSHOT_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
  // Quotes older than this are refused at reservation time (ADR-003).
  FX_MAX_AGE_SECONDS: z.coerce.number().int().min(1).max(86_400).default(3600),
  // Comma-separated origins allowed to call the API from a browser (e.g. Swagger UI on the
  // management port in dev). Empty = CORS disabled.
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0),
    ),
  JWT_PUBLIC_KEY_PATH: z.string().min(1).default('dev/jwt/public.pem'),
  JWT_ISSUER: z.string().min(1).default('capacity-dev-issuer'),
  JWT_AUDIENCE: z.string().min(1).default('program-capacity-api'),
  JWT_CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().min(0).max(300).default(30),
});

/** Validated, typed runtime configuration. */
export type Env = z.infer<typeof envSchema>;

/**
 * `ConfigModule` validate hook: parses `process.env` against {@link envSchema}.
 * @throws Error listing every invalid variable, so boot fails fast.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
