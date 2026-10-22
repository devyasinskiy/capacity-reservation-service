import { randomUUID } from 'node:crypto';
import { DomainError } from '../../../shared/errors/domain-error';
import { Money } from '../../../shared/money/money';
import { Program } from '../domain/program';
import type { TreasuryMessage } from '../messaging/treasury-message.schema';
import type {
  CapacityStore,
  ChangeContext,
  InboxEntry,
  LockedProgramSession,
  ProgramKey,
} from './ports/capacity-store';
import { type CapacityMetrics, NO_METRICS } from './ports/capacity-metrics';
import { ReconcileSnapshot } from './reconcile-snapshot';

/** Kafka coordinates of the message being applied; stored in the inbox for traceability. */
export interface MessageSource {
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
}

/** What happened to a message; `DUPLICATE` means it was already in the inbox. */
export type MessageOutcome = InboxEntry['outcome'] | 'DUPLICATE';

type LimitSet = Extract<TreasuryMessage, { type: 'PROGRAM_LIMIT_SET' }>;
type ExternalCreated = Extract<TreasuryMessage, { type: 'EXTERNAL_RESERVATION_CREATED' }>;
type ExternalReleased = Extract<TreasuryMessage, { type: 'EXTERNAL_RESERVATION_RELEASED' }>;

/**
 * Applies one validated treasury message, at-least-once safe (ADR-010):
 *  - duplicates (same messageId) are detected via the inbox, written in the same transaction as
 *    the effect, so "applied" and "recorded" can never diverge;
 *  - absolute messages (LIMIT_SET) apply only if newer than the program's limit watermark;
 *  - deltas (external reserve/release) are idempotent by externalRef.
 * Business-rule violations surface as DomainError (non-retryable); infrastructure failures as
 * RetryableError. The consumer decides retry vs dead-letter (ADR-012).
 */
export class ApplyTreasuryMessage {
  private readonly snapshots: ReconcileSnapshot;
  private readonly metrics: CapacityMetrics;

  constructor(
    private readonly store: CapacityStore,
    options: { graceWindowMs?: number; metrics?: CapacityMetrics } = {},
  ) {
    this.metrics = options.metrics ?? NO_METRICS;
    this.snapshots = new ReconcileSnapshot(
      store,
      options.graceWindowMs ?? 5 * 60_000,
      options.metrics ?? NO_METRICS,
    );
  }

  /**
   * Applies `message` exactly once in effect, regardless of redelivery.
   * @throws DomainError for permanent business-rule violations (dead-lettered by the consumer).
   * @throws RetryableError for transient infrastructure failures (retried).
   */
  async execute(
    message: TreasuryMessage,
    source: MessageSource,
    correlationId?: string,
  ): Promise<MessageOutcome> {
    if (await this.store.isMessageProcessed(message.messageId)) return 'DUPLICATE';

    const key: ProgramKey = { tenantId: message.tenantId, programId: message.programId };
    const context: ChangeContext = {
      source: 'KAFKA',
      sourceRef: message.messageId,
      correlationId: correlationId ?? null,
    };
    const inbox = (outcome: InboxEntry['outcome']): InboxEntry => ({
      messageId: message.messageId,
      type: message.type,
      version: message.version,
      ...source,
      outcome,
    });

    switch (message.type) {
      case 'PROGRAM_LIMIT_SET':
        return this.limitSet(message, key, context, inbox);
      case 'EXTERNAL_RESERVATION_CREATED':
        return this.locked(key, context, message.messageId, 'EXTERNAL_RESERVATION', (s) =>
          this.externalCreated(s, message, inbox),
        );
      case 'EXTERNAL_RESERVATION_RELEASED':
        return this.locked(key, context, message.messageId, null, (s) =>
          this.externalReleased(s, message, inbox),
        );
      case 'PROGRAM_RECONCILIATION_SNAPSHOT':
        return this.snapshots.handlePart(message, key, context, inbox);
    }
  }

  private async limitSet(
    m: LimitSet,
    key: ProgramKey,
    context: ChangeContext,
    inbox: (o: InboxEntry['outcome']) => InboxEntry,
  ): Promise<MessageOutcome> {
    const limit = Money.parse(m.payload.limitMinor, m.payload.currency);
    // Programs come into existence from treasury's first LIMIT_SET (assumption A1).
    if (!(await this.store.findProgram(key))) {
      const { program, movement } = Program.open({ ...key, limit, version: m.version });
      if (await this.store.createProgram(program, movement, context, inbox('APPLIED')))
        return 'APPLIED';
      // Lost a creation race (or a concurrent duplicate): fall through to the locked path.
    }
    return this.locked(key, context, m.messageId, 'LIMIT_SET', async (s) => {
      const outcome = s.program.setLimit(limit, m.version);
      if (outcome.applied) await s.recordMovement(outcome.movement);
      const result = outcome.applied ? 'APPLIED' : 'STALE';
      await s.recordInboxMessage(inbox(result));
      return result;
    });
  }

  private async externalCreated(
    s: LockedProgramSession,
    m: ExternalCreated,
    inbox: (o: InboxEntry['outcome']) => InboxEntry,
  ): Promise<MessageOutcome> {
    const amount = Money.parse(m.payload.amountMinor, m.payload.currency);
    const existing = await s.findReservationByExternalRef(m.payload.externalRef);
    if (existing) {
      // Re-sent with a new messageId: same facts → no-op; different facts → operator must look.
      if (!existing.programAmount.equals(amount) || existing.invoiceId !== m.payload.invoiceId) {
        throw new DomainError(
          'RESERVATION_CONFLICT',
          'External reservation already exists with different data',
          {
            externalRef: m.payload.externalRef,
          },
        );
      }
      await s.recordInboxMessage(inbox('ALREADY_APPLIED'));
      return 'ALREADY_APPLIED';
    }
    const { reservation, movement } = s.program.applyExternalReservation({
      reservationId: randomUUID(),
      externalRef: m.payload.externalRef,
      invoiceId: m.payload.invoiceId,
      amount,
      occurredAt: m.occurredAt,
    });
    await s.saveReservation(reservation);
    await s.recordMovement(movement);
    await s.recordInboxMessage(inbox('APPLIED'));
    return 'APPLIED';
  }

  private async externalReleased(
    s: LockedProgramSession,
    m: ExternalReleased,
    inbox: (o: InboxEntry['outcome']) => InboxEntry,
  ): Promise<MessageOutcome> {
    const reservation = await s.findReservationByExternalRef(m.payload.externalRef);
    if (!reservation) {
      throw new DomainError('RESERVATION_NOT_FOUND', 'Unknown external reservation', {
        externalRef: m.payload.externalRef,
      });
    }
    const { movement } = s.program.release(
      reservation,
      Money.parse(m.payload.amountMinor, m.payload.currency),
    );
    await s.saveReservation(reservation);
    await s.recordMovement(movement);
    await s.recordInboxMessage(inbox('APPLIED'));
    return 'APPLIED';
  }

  /** Runs under the program lock, re-checking the inbox now that we are serialised. */
  private async locked(
    key: ProgramKey,
    context: ChangeContext,
    messageId: string,
    overLimitSource: 'LIMIT_SET' | 'EXTERNAL_RESERVATION' | null,
    work: (s: LockedProgramSession) => Promise<MessageOutcome>,
  ): Promise<MessageOutcome> {
    let crossed = false;
    const outcome = await this.store.withLockedProgram(key, context, async (s) => {
      if (await s.isMessageProcessed(messageId)) return 'DUPLICATE';
      const wasOver = s.program.overLimit;
      const result = await work(s);
      crossed = !wasOver && s.program.overLimit;
      return result;
    });
    // Reported after commit (ADR-013): treasury may legitimately push a program over its limit.
    if (crossed && overLimitSource) this.metrics.overLimitTransition(overLimitSource);
    return outcome;
  }
}
