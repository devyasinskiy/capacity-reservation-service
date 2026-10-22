import { randomUUID } from 'node:crypto';
import { DomainError } from '../../../shared/errors/domain-error';
import { Money } from '../../../shared/money/money';
import { classifyCandidates, diffSnapshot } from '../domain/reconciliation';
import type { TreasuryMessage } from '../messaging/treasury-message.schema';
import type {
  CapacityStore,
  ChangeContext,
  InboxEntry,
  ProgramKey,
  SnapshotHeader,
} from './ports/capacity-store';
import { type CapacityMetrics, NO_METRICS } from './ports/capacity-metrics';

type SnapshotMessage = Extract<TreasuryMessage, { type: 'PROGRAM_RECONCILIATION_SNAPSHOT' }>;
type Outcome = InboxEntry['outcome'] | 'DUPLICATE';
type StageResult = { done: Outcome } | { complete: true } | { reject: DomainError };

/**
 * Chunked snapshot staging + reconciliation (ADR-011, ADR-020).
 *
 * 1. Stage the part under the program lock (short): version/supersede/consistency checks.
 * 2. When the set is complete: load it and rebuild local state as of `asOf` from the ledger,
 *    and diff — all OUTSIDE the lock, so a large snapshot never blocks reservations.
 * 3. Under the lock again: re-check the snapshot watermark, apply the two-strike rule, apply the
 *    limit (only if newer than the limit watermark), record the run, drop the staged parts.
 *
 * Crash safety: the inbox entry of the part that *completes* the set is written in step 3, not
 * step 1. If we die between them, that part is redelivered, re-staging is a no-op, and the
 * reconciliation runs again.
 */
export class ReconcileSnapshot {
  constructor(
    private readonly store: CapacityStore,
    private readonly graceWindowMs: number,
    private readonly metrics: CapacityMetrics = NO_METRICS,
  ) {}

  /**
   * Stages one snapshot part and, if it completes the set, reconciles the program.
   * @throws DomainError `CURRENCY_MISMATCH` or `SNAPSHOT_INCONSISTENT` for a malformed set.
   */
  async handlePart(
    m: SnapshotMessage,
    key: ProgramKey,
    context: ChangeContext,
    inbox: (outcome: InboxEntry['outcome']) => InboxEntry,
  ): Promise<Outcome> {
    const header: SnapshotHeader = {
      snapshotId: m.payload.snapshotId,
      version: m.version,
      asOf: new Date(m.payload.asOf),
      currency: m.payload.currency,
      limitMinor: m.payload.limitMinor,
      totalParts: m.payload.totalParts,
    };

    const staged = await this.store.withLockedProgram<StageResult>(key, context, async (s) => {
      if (await s.isMessageProcessed(m.messageId)) return { done: 'DUPLICATE' };
      const stale = async (): Promise<StageResult> => {
        await s.recordInboxMessage(inbox('STALE'));
        return { done: 'STALE' };
      };
      if (s.program.isSnapshotStale(header.version)) return stale();
      if (header.currency !== s.program.currencyCode) {
        return {
          reject: new DomainError(
            'CURRENCY_MISMATCH',
            'Snapshot currency differs from program currency',
          ),
        };
      }

      const existing = await s.stagedSnapshots();
      // Never mix versions: a newer staged snapshot makes this part obsolete...
      if (existing.some((e) => e.header.version > header.version)) return stale();
      // ...and this part supersedes any older incomplete snapshot.
      const superseded = existing
        .filter((e) => e.header.version < header.version)
        .map((e) => e.header.snapshotId);
      await s.discardStagedSnapshots(superseded);

      const sameVersion = existing.filter((e) => e.header.version === header.version);
      const sibling = sameVersion.find((e) => e.header.snapshotId === header.snapshotId);
      const conflicting = sameVersion.some((e) => e.header.snapshotId !== header.snapshotId);
      if (conflicting || (sibling && !sameHeader(sibling.header, header))) {
        // Discard the whole set (committed), then dead-letter this part for an operator.
        await s.discardStagedSnapshots(sameVersion.map((e) => e.header.snapshotId));
        return {
          reject: new DomainError(
            'SNAPSHOT_INCONSISTENT',
            'Snapshot parts disagree on header fields',
            {
              snapshotId: header.snapshotId,
            },
          ),
        };
      }

      const entries = m.payload.reservations.map((r) => ({
        ...r,
        outstandingMinor: BigInt(r.outstandingMinor),
      }));
      const inserted = await s.stageSnapshotPart(header, m.payload.part, entries);
      const parts = (sibling?.parts ?? 0) + (inserted ? 1 : 0);
      if (parts < header.totalParts) {
        const outcome = inserted ? 'STAGED' : 'ALREADY_APPLIED';
        await s.recordInboxMessage(inbox(outcome));
        return { done: outcome };
      }
      return { complete: true };
    });

    if ('reject' in staged) throw staged.reject;
    if ('done' in staged) return staged.done;
    return this.reconcile(key, header, context, m.messageId, inbox);
  }

  private async reconcile(
    key: ProgramKey,
    header: SnapshotHeader,
    context: ChangeContext,
    messageId: string,
    inbox: (outcome: InboxEntry['outcome']) => InboxEntry,
  ): Promise<Outcome> {
    // Outside the lock: potentially large reads and the pure diff.
    const snapshot = await this.store.loadStagedSnapshot(key, header.snapshotId);
    const diff = snapshot
      ? diffSnapshot({
          asOf: header.asOf,
          graceWindowMs: this.graceWindowMs,
          snapshot: snapshot.entries,
          local: await this.store.localStateAsOf(key, header.asOf),
        })
      : null;

    let applied:
      | {
          limitApplied: boolean;
          classification: ReturnType<typeof classifyCandidates>;
          crossedOverLimit: boolean;
        }
      | undefined;
    const outcome = await this.store.withLockedProgram(
      key,
      context,
      async (s): Promise<Outcome> => {
        if (await s.isMessageProcessed(messageId)) return 'DUPLICATE';
        // Applied by a concurrent redelivery, superseded, or swept since we read it: nothing to do.
        const stillStaged = (await s.stagedSnapshots()).some(
          (e) => e.header.snapshotId === header.snapshotId && e.parts === header.totalParts,
        );
        if (!diff || !stillStaged || s.program.isSnapshotStale(header.version)) {
          await s.recordInboxMessage(inbox('STALE'));
          return 'STALE';
        }

        const classification = classifyCandidates(diff, await s.pendingDiscrepancies());
        const wasOver = s.program.overLimit;
        const limit = s.program.applySnapshot(
          Money.parse(header.limitMinor, header.currency),
          header.version,
        );
        if (limit.applied) await s.recordMovement(limit.movement);
        await s.recordReconciliation({
          runId: randomUUID(),
          header,
          diff,
          classification,
          limitApplied: limit.applied,
        });
        await s.recordInboxMessage(inbox('APPLIED'));
        applied = {
          limitApplied: limit.applied,
          classification,
          crossedOverLimit: !wasOver && s.program.overLimit,
        };
        return 'APPLIED';
      },
    );
    if (applied && diff) {
      // Reported only after commit, so metrics never count a rolled-back run.
      this.metrics.reconciliation({
        limitApplied: applied.limitApplied,
        uncertain: diff.uncertain.length,
        pending: applied.classification.toPending.length,
        opened: applied.classification.toOpen.length,
        cleared: applied.classification.toClear.length,
      });
      if (applied.crossedOverLimit) this.metrics.overLimitTransition('SNAPSHOT');
    }
    return outcome;
  }
}

function sameHeader(a: SnapshotHeader, b: SnapshotHeader): boolean {
  return (
    a.snapshotId === b.snapshotId &&
    a.version === b.version &&
    a.asOf.getTime() === b.asOf.getTime() &&
    a.currency === b.currency &&
    a.limitMinor === b.limitMinor &&
    a.totalParts === b.totalParts
  );
}
