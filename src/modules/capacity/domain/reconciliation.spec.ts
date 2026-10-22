import {
  classifyCandidates,
  diffSnapshot,
  type LocalEntryAsOf,
  type PendingDiscrepancy,
  type SnapshotEntry,
} from './reconciliation';

const asOf = new Date('2026-10-11T12:00:00Z');
const GRACE = 5 * 60_000;
const minutesBefore = (m: number) => new Date(asOf.getTime() - m * 60_000);

const snap = (
  ref: string,
  outstanding: bigint,
  origin: 'LOCAL' | 'EXTERNAL' = 'LOCAL',
): SnapshotEntry => ({
  origin,
  ref,
  invoiceId: `inv-${ref}`,
  outstandingMinor: outstanding,
});
const local = (
  ref: string,
  outstanding: bigint,
  minsAgo = 60,
  origin: 'LOCAL' | 'EXTERNAL' = 'LOCAL',
): LocalEntryAsOf => ({
  origin,
  ref,
  invoiceId: `inv-${ref}`,
  outstandingMinor: outstanding,
  lastMovementAt: minutesBefore(minsAgo),
});
const diff = (snapshot: SnapshotEntry[], loc: LocalEntryAsOf[]) =>
  diffSnapshot({ asOf, graceWindowMs: GRACE, snapshot, local: loc });

describe('diffSnapshot', () => {
  it('finds nothing when both views agree (incl. fully released on both sides)', () => {
    const d = diff([snap('a', 100n), snap('b', 0n)], [local('a', 100n), local('b', 0n)]);
    expect(d.candidates).toEqual([]);
    expect(d.uncertain).toEqual([]);
    expect(d.treasuryTotalMinor).toBe(100n);
    expect(d.localTotalMinor).toBe(100n);
  });

  it('flags a reservation treasury has and we do not', () => {
    expect(diff([snap('x', 50n, 'EXTERNAL')], []).candidates).toEqual([
      {
        kind: 'MISSING_LOCALLY',
        origin: 'EXTERNAL',
        ref: 'x',
        invoiceId: 'inv-x',
        localOutstandingMinor: null,
        treasuryOutstandingMinor: 50n,
      },
    ]);
  });

  it('flags an old local reservation treasury does not know', () => {
    expect(diff([], [local('a', 70n, 30)]).candidates).toMatchObject([
      { kind: 'MISSING_IN_TREASURY', ref: 'a', localOutstandingMinor: 70n },
    ]);
  });

  it('flags amount mismatches', () => {
    expect(diff([snap('a', 60n)], [local('a', 100n)]).candidates).toMatchObject([
      { kind: 'AMOUNT_MISMATCH', localOutstandingMinor: 100n, treasuryOutstandingMinor: 60n },
    ]);
  });

  it('treats a reservation made just before asOf and missing from the snapshot as UNCERTAIN, not a strike', () => {
    const d = diff([], [local('fresh', 10n, 1)]);
    expect(d.candidates).toEqual([]);
    expect(d.uncertain).toMatchObject([{ kind: 'MISSING_IN_TREASURY', ref: 'fresh' }]);
  });

  it('treats a release just before asOf (amount mismatch) as UNCERTAIN', () => {
    expect(diff([snap('a', 100n)], [local('a', 40n, 2)]).uncertain).toHaveLength(1);
  });

  it.each([
    // skewed clocks: treasury asOf vs our DB time — the window absorbs a few minutes either way
    ['4m59s before asOf → uncertain', 4 + 59 / 60, 'uncertain'],
    ['exactly at window start → uncertain', 5, 'uncertain'],
    ['5m01s before asOf → strike', 5 + 1 / 60, 'candidates'],
  ] as const)('grace window boundary: %s', (_l, mins, bucket) => {
    const d = diff([], [local('a', 10n, mins)]);
    expect(d[bucket]).toHaveLength(1);
  });

  it('distinguishes LOCAL and EXTERNAL refs with the same id', () => {
    const d = diff([snap('same', 10n, 'EXTERNAL')], [local('same', 10n, 60, 'LOCAL')]);
    expect(d.candidates.map((c) => c.kind).sort()).toEqual([
      'MISSING_IN_TREASURY',
      'MISSING_LOCALLY',
    ]);
  });
});

describe('classifyCandidates (two-strike rule)', () => {
  const pending = (
    id: string,
    ref: string,
    kind: PendingDiscrepancy['kind'] = 'MISSING_IN_TREASURY',
  ): PendingDiscrepancy => ({
    id,
    kind,
    origin: 'LOCAL',
    ref,
  });

  it('first miss → PENDING (not flagged)', () => {
    const c = classifyCandidates(diff([], [local('a', 10n)]), []);
    expect(c.toPending).toHaveLength(1);
    expect(c.toOpen).toEqual([]);
  });

  it('missing in two consecutive snapshots → OPEN (flagged)', () => {
    const c = classifyCandidates(diff([], [local('a', 10n)]), [pending('d-1', 'a')]);
    expect(c.toOpen).toMatchObject([{ pendingId: 'd-1', candidate: { ref: 'a' } }]);
    expect(c.toPending).toEqual([]);
    expect(c.toClear).toEqual([]);
  });

  it('pending that the next snapshot no longer reproduces → CLEARED', () => {
    const c = classifyCandidates(diff([snap('a', 10n)], [local('a', 10n)]), [pending('d-1', 'a')]);
    expect(c.toClear).toEqual(['d-1']);
  });

  it('a different kind for the same reservation is a new first strike', () => {
    const c = classifyCandidates(diff([snap('a', 5n)], [local('a', 10n)]), [
      pending('d-1', 'a', 'MISSING_IN_TREASURY'),
    ]);
    expect(c.toPending).toMatchObject([{ kind: 'AMOUNT_MISMATCH' }]);
    expect(c.toClear).toEqual(['d-1']);
  });

  it('uncertain items neither strike nor clear an existing pending', () => {
    const c = classifyCandidates(diff([], [local('a', 10n, 1)]), [pending('d-1', 'a')]);
    expect(c).toEqual({ toOpen: [], toPending: [], toClear: [] });
  });
});
