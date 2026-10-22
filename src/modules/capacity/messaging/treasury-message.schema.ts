import { z } from 'zod';

/**
 * Treasury → capacity contract (ADR-010), validated with zod at the Kafka boundary.
 * Assumed schema (none was given): documented in docs/PLAN.md §2.4 and README.
 * Money is a string of integer minor units, exactly like the HTTP API (ADR-002).
 */

const SAFE_ID = /^[A-Za-z0-9._:/-]{1,128}$/;
const minorUnits = z.string().regex(/^\d{1,19}$/, 'must be an integer string of minor units');
const positiveMinorUnits = minorUnits.refine((v) => BigInt(v) > 0n, 'must be positive');
const currency = z.string().regex(/^[A-Z]{3}$/, 'must be an ISO 4217 code');

/** Accepts 42 or "42"; always yields bigint (versions may exceed 2^53 over a program's life). */
const version = z
  .union([
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    z.string().regex(/^\d{1,19}$/),
  ])
  .transform((v) => BigInt(v))
  .refine((v) => v > 0n, 'must be positive');

const envelope = {
  messageId: z.string().regex(SAFE_ID),
  schemaVersion: z.literal(1),
  tenantId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  programId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  /** Producer-assigned, monotonic per program across all message types. */
  version,
  occurredAt: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
};

/** `PROGRAM_LIMIT_SET`: absolute new limit; applied only if newer than the limit watermark. */
export const programLimitSetSchema = z.object({
  ...envelope,
  type: z.literal('PROGRAM_LIMIT_SET'),
  payload: z.object({ currency, limitMinor: minorUnits }).strict(),
});

/** `EXTERNAL_RESERVATION_CREATED`: a reservation made in treasury, idempotent by `externalRef`. */
export const externalReservationCreatedSchema = z.object({
  ...envelope,
  type: z.literal('EXTERNAL_RESERVATION_CREATED'),
  payload: z
    .object({
      externalRef: z.string().regex(SAFE_ID),
      invoiceId: z.string().regex(SAFE_ID),
      /** In program currency; must match the program (checked in the domain). */
      currency,
      amountMinor: positiveMinorUnits,
    })
    .strict(),
});

/** `EXTERNAL_RESERVATION_RELEASED`: (partial) release of an external reservation. */
export const externalReservationReleasedSchema = z.object({
  ...envelope,
  type: z.literal('EXTERNAL_RESERVATION_RELEASED'),
  payload: z
    .object({
      externalRef: z.string().regex(SAFE_ID),
      currency,
      /** Partial releases allowed; the domain rejects over-release. */
      amountMinor: positiveMinorUnits,
    })
    .strict(),
});

/** One reservation's outstanding amount in a reconciliation snapshot. */
export const snapshotEntrySchema = z
  .object({
    origin: z.enum(['LOCAL', 'EXTERNAL']),
    ref: z.string().regex(SAFE_ID),
    invoiceId: z.string().regex(SAFE_ID),
    outstandingMinor: minorUnits,
  })
  .strict();

/** One part of a (possibly chunked) reconciliation snapshot (ADR-011, ADR-020). */
export const programReconciliationSnapshotSchema = z.object({
  ...envelope,
  type: z.literal('PROGRAM_RECONCILIATION_SNAPSHOT'),
  payload: z
    .object({
      snapshotId: z.string().regex(SAFE_ID),
      part: z.number().int().min(1),
      totalParts: z.number().int().min(1).max(10_000),
      asOf: z.iso.datetime({ offset: true }),
      currency,
      limitMinor: minorUnits,
      reservations: z.array(snapshotEntrySchema).max(50_000),
    })
    .strict()
    .refine((p) => p.part <= p.totalParts, {
      message: 'part must be ≤ totalParts',
      path: ['part'],
    }),
});

/** Any treasury message, discriminated by `type`. */
export const treasuryMessageSchema = z.discriminatedUnion('type', [
  programLimitSetSchema,
  externalReservationCreatedSchema,
  externalReservationReleasedSchema,
  programReconciliationSnapshotSchema,
]);

/** A validated treasury message (versions as bigint, `occurredAt` as Date). */
export type TreasuryMessage = z.infer<typeof treasuryMessageSchema>;
/** Discriminator values of {@link TreasuryMessage}. */
export type TreasuryMessageType = TreasuryMessage['type'];

/** Malformed input: retrying cannot help, so it is never retried (ADR-012). */
export class InvalidTreasuryMessageError extends Error {
  constructor(
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(message);
    this.name = 'InvalidTreasuryMessageError';
  }
}

/**
 * Decodes and validates a raw Kafka value.
 * @throws InvalidTreasuryMessageError for tombstones, invalid JSON or schema violations.
 */
export function parseTreasuryMessage(value: Buffer | string | null): TreasuryMessage {
  if (value === null) throw new InvalidTreasuryMessageError('Empty message (tombstone)');
  let json: unknown;
  try {
    json = JSON.parse(typeof value === 'string' ? value : value.toString('utf8'));
  } catch {
    throw new InvalidTreasuryMessageError('Message is not valid JSON');
  }
  const result = treasuryMessageSchema.safeParse(json);
  if (!result.success) {
    throw new InvalidTreasuryMessageError(
      'Message does not match the treasury schema',
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return result.data;
}
