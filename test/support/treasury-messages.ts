import { randomUUID } from 'node:crypto';

export interface SnapshotRow {
  origin: 'LOCAL' | 'EXTERNAL';
  ref: string;
  invoiceId: string;
  outstandingMinor: string;
}

/** Builders for raw (wire-format) treasury messages, as the producer would send them. */
export function treasuryMessages(tenantId: string, programId: string) {
  let version = 0;
  const envelope = (
    type: string,
    payload: object,
    overrides: { version?: number; messageId?: string } = {},
  ) => ({
    messageId: overrides.messageId ?? randomUUID(),
    type,
    schemaVersion: 1,
    tenantId,
    programId,
    version: overrides.version ?? ++version,
    occurredAt: new Date().toISOString(),
    payload,
  });
  return {
    limitSet: (
      limitMinor: string,
      currency = 'USD',
      o?: { version?: number; messageId?: string },
    ) => envelope('PROGRAM_LIMIT_SET', { currency, limitMinor }, o),
    externalCreated: (
      externalRef: string,
      amountMinor: string,
      o?: { version?: number; messageId?: string; invoiceId?: string; currency?: string },
    ) =>
      envelope(
        'EXTERNAL_RESERVATION_CREATED',
        {
          externalRef,
          invoiceId: o?.invoiceId ?? `INV-${externalRef}`,
          currency: o?.currency ?? 'USD',
          amountMinor,
        },
        o,
      ),
    externalReleased: (
      externalRef: string,
      amountMinor: string,
      o?: { version?: number; messageId?: string; currency?: string },
    ) =>
      envelope(
        'EXTERNAL_RESERVATION_RELEASED',
        { externalRef, currency: o?.currency ?? 'USD', amountMinor },
        o,
      ),

    /** Splits `reservations` into `totalParts` messages sharing version, snapshotId and header. */
    snapshot: (o: {
      asOf: Date;
      limitMinor: string;
      reservations: SnapshotRow[];
      totalParts?: number;
      version?: number;
      snapshotId?: string;
      currency?: string;
    }) => {
      const totalParts = o.totalParts ?? 1;
      const snapshotVersion = o.version ?? ++version;
      const snapshotId = o.snapshotId ?? `SNAP-${randomUUID().slice(0, 8)}`;
      return Array.from({ length: totalParts }, (_, i) =>
        envelope(
          'PROGRAM_RECONCILIATION_SNAPSHOT',
          {
            snapshotId,
            part: i + 1,
            totalParts,
            asOf: o.asOf.toISOString(),
            currency: o.currency ?? 'USD',
            limitMinor: o.limitMinor,
            reservations: o.reservations.filter((_, idx) => idx % totalParts === i),
          },
          { version: snapshotVersion },
        ),
      );
    },
  };
}
