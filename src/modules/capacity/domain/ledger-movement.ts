/** One append-only ledger row, produced by every state change on a program (ADR-008). */
export type MovementType =
  'RESERVE' | 'RELEASE' | 'LIMIT_SET' | 'EXTERNAL_RESERVE' | 'EXTERNAL_RELEASE';

/** A ledger row as produced by the domain; persistence adds source and correlation metadata. */
export interface LedgerMovement {
  readonly type: MovementType;
  readonly reservationId: string | null;
  /** Change to `reserved`, program-currency minor units (0 for LIMIT_SET). */
  readonly reservedDelta: bigint;
  readonly limitAfter: bigint;
  readonly reservedAfter: bigint;
}
