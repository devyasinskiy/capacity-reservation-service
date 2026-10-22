import type { ReservationOrigin } from './reservation';

/**
 * Pure reconciliation logic (ADR-011). Two steps:
 *  1. `diffSnapshot` — compare treasury's view as of `asOf` with our own state *as of `asOf`*
 *     (rebuilt from the ledger). Runs outside the program lock.
 *  2. `classifyCandidates` — apply the two-strike rule against discrepancies still PENDING from
 *     the previous snapshot. Runs under the lock.
 * Nothing here mutates capacity; differences are only ever flagged for human review.
 */

export type DiscrepancyKind = 'MISSING_LOCALLY' | 'MISSING_IN_TREASURY' | 'AMOUNT_MISMATCH';

/** One reservation as treasury sees it in a snapshot. */
export interface SnapshotEntry {
  readonly origin: ReservationOrigin;
  /** LOCAL: our reservation id; EXTERNAL: treasury's externalRef. */
  readonly ref: string;
  readonly invoiceId: string;
  readonly outstandingMinor: bigint;
}

/** One reservation as we saw it at the snapshot's `asOf`, rebuilt from the ledger. */
export interface LocalEntryAsOf {
  readonly origin: ReservationOrigin;
  readonly ref: string;
  readonly invoiceId: string;
  /** Σ ledger deltas for this reservation with occurred_at <= asOf. */
  readonly outstandingMinor: bigint;
  /** Time of the last ledger movement <= asOf; drives the grace window. */
  readonly lastMovementAt: Date;
}

/** A difference between treasury and local state for one reservation. */
export interface DiscrepancyCandidate {
  readonly kind: DiscrepancyKind;
  readonly origin: ReservationOrigin;
  readonly ref: string;
  readonly invoiceId: string;
  readonly localOutstandingMinor: bigint | null;
  readonly treasuryOutstandingMinor: bigint | null;
}

/** Output of {@link diffSnapshot}. */
export interface SnapshotDiff {
  /** Definite mismatches: count as a strike. */
  readonly candidates: readonly DiscrepancyCandidate[];
  /** Mismatches explained by propagation delay (local change inside the grace window): no strike. */
  readonly uncertain: readonly DiscrepancyCandidate[];
  readonly treasuryTotalMinor: bigint;
  readonly localTotalMinor: bigint;
}

/** Stable identity of a discrepancy across snapshots: kind + origin + ref. */
export function discrepancyKey(d: {
  kind: DiscrepancyKind;
  origin: ReservationOrigin;
  ref: string;
}): string {
  return `${d.kind}|${d.origin}|${d.ref}`;
}

const entryKey = (e: { origin: ReservationOrigin; ref: string }) => `${e.origin}|${e.ref}`;

/**
 * Compares a snapshot with local state as of the same `asOf`. Pure; never mutates capacity.
 * Mismatches whose last local movement falls inside the grace window are `uncertain`.
 */
export function diffSnapshot(params: {
  asOf: Date;
  graceWindowMs: number;
  snapshot: readonly SnapshotEntry[];
  local: readonly LocalEntryAsOf[];
}): SnapshotDiff {
  const graceStart = params.asOf.getTime() - params.graceWindowMs;
  const local = new Map(params.local.map((e) => [entryKey(e), e]));
  const seen = new Set<string>();
  const candidates: DiscrepancyCandidate[] = [];
  const uncertain: DiscrepancyCandidate[] = [];

  // A mismatch caused by a local change treasury may simply not have seen yet is not a strike.
  const record = (c: DiscrepancyCandidate, localEntry: LocalEntryAsOf | undefined) => {
    const recent = localEntry !== undefined && localEntry.lastMovementAt.getTime() >= graceStart;
    (recent ? uncertain : candidates).push(c);
  };

  let treasuryTotal = 0n;
  for (const s of params.snapshot) {
    treasuryTotal += s.outstandingMinor;
    const key = entryKey(s);
    seen.add(key);
    const l = local.get(key);
    if (!l) {
      if (s.outstandingMinor !== 0n) {
        candidates.push({
          kind: 'MISSING_LOCALLY',
          origin: s.origin,
          ref: s.ref,
          invoiceId: s.invoiceId,
          localOutstandingMinor: null,
          treasuryOutstandingMinor: s.outstandingMinor,
        });
      }
    } else if (l.outstandingMinor !== s.outstandingMinor) {
      record(
        {
          kind: 'AMOUNT_MISMATCH',
          origin: s.origin,
          ref: s.ref,
          invoiceId: s.invoiceId,
          localOutstandingMinor: l.outstandingMinor,
          treasuryOutstandingMinor: s.outstandingMinor,
        },
        l,
      );
    }
  }

  let localTotal = 0n;
  for (const l of params.local) {
    localTotal += l.outstandingMinor;
    if (seen.has(entryKey(l)) || l.outstandingMinor === 0n) continue;
    record(
      {
        kind: 'MISSING_IN_TREASURY',
        origin: l.origin,
        ref: l.ref,
        invoiceId: l.invoiceId,
        localOutstandingMinor: l.outstandingMinor,
        treasuryOutstandingMinor: null,
      },
      l,
    );
  }

  return { candidates, uncertain, treasuryTotalMinor: treasuryTotal, localTotalMinor: localTotal };
}

/** A first-strike discrepancy carried over from the previous snapshot. */
export interface PendingDiscrepancy {
  readonly id: string;
  readonly kind: DiscrepancyKind;
  readonly origin: ReservationOrigin;
  readonly ref: string;
}

/** Output of {@link classifyCandidates}: which discrepancies to open, mark pending or clear. */
export interface Classification {
  /** Second consecutive strike: flag for review (status OPEN). */
  readonly toOpen: ReadonlyArray<{ pendingId: string; candidate: DiscrepancyCandidate }>;
  /** First strike: record as PENDING. */
  readonly toPending: readonly DiscrepancyCandidate[];
  /** Previously pending, not reproduced by this snapshot: CLEARED. */
  readonly toClear: readonly string[];
}

/**
 * Two-strike rule (ADR-011). Uncertain items neither strike nor clear: their pending state, if
 * any, carries over to the next snapshot unchanged.
 */
export function classifyCandidates(
  diff: SnapshotDiff,
  pending: readonly PendingDiscrepancy[],
): Classification {
  const pendingByKey = new Map(pending.map((p) => [discrepancyKey(p), p]));
  const uncertainKeys = new Set(diff.uncertain.map(discrepancyKey));
  const toOpen: Array<{ pendingId: string; candidate: DiscrepancyCandidate }> = [];
  const toPending: DiscrepancyCandidate[] = [];
  const struck = new Set<string>();

  for (const candidate of diff.candidates) {
    const key = discrepancyKey(candidate);
    struck.add(key);
    const prior = pendingByKey.get(key);
    if (prior) toOpen.push({ pendingId: prior.id, candidate });
    else toPending.push(candidate);
  }

  const toClear = pending
    .filter((p) => !struck.has(discrepancyKey(p)) && !uncertainKeys.has(discrepancyKey(p)))
    .map((p) => p.id);

  return { toOpen, toPending, toClear };
}
