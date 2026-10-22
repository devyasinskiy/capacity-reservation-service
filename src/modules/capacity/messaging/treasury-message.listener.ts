import { setTimeout as sleep } from 'node:timers/promises';
import { Logger } from '@nestjs/common';
import { runWithCorrelationId } from '../../../shared/context/correlation-context';
import { resolveCorrelationId } from '../../../shared/context/correlation-id';
import type { ApplyTreasuryMessage } from '../application/apply-treasury-message';
import { type CapacityMetrics, NO_METRICS } from '../application/ports/capacity-metrics';
import type {
  DeadLetterPublisher,
  InboundMessage,
  TreasuryMessageConsumer,
} from '../application/ports/treasury-messaging';
import { backoffDelay, classifyFailure, type RetryPolicy } from './retry-policy';
import { parseTreasuryMessage } from './treasury-message.schema';

/**
 * Glue between the transport and the use case: parse → apply → (retry | dead-letter).
 * Resolves only when the message is either applied or safely in the DLQ, so the consumer can
 * commit the offset; rejects (no commit → redelivery) only if the DLQ itself is unreachable or
 * we are shutting down mid-retry. Never blocks a partition forever (ADR-012).
 */
export class TreasuryMessageListener {
  private readonly logger = new Logger(TreasuryMessageListener.name);
  private readonly shutdown = new AbortController();

  constructor(
    private readonly consumer: TreasuryMessageConsumer,
    private readonly apply: ApplyTreasuryMessage,
    private readonly deadLetters: DeadLetterPublisher,
    private readonly policy: RetryPolicy,
    private readonly metrics: CapacityMetrics = NO_METRICS,
  ) {}

  /** Starts the consumer with {@link handle} as its message handler. */
  start(): Promise<void> {
    return this.consumer.start((m) => this.handle(m));
  }

  /** Aborts pending retry back-offs, then stops the consumer. */
  async stop(): Promise<void> {
    this.shutdown.abort();
    await this.consumer.stop();
  }

  /**
   * Processes one message inside its correlation context (from `x-correlation-id` or new).
   * Resolves once applied or dead-lettered; rejects only if the message must be redelivered.
   */
  handle(raw: InboundMessage): Promise<void> {
    const correlationId = resolveCorrelationId(raw.headers['x-correlation-id']);
    return runWithCorrelationId(correlationId, () => this.process(raw, correlationId));
  }

  private async process(raw: InboundMessage, correlationId: string): Promise<void> {
    const where = { topic: raw.topic, partition: raw.partition, offset: raw.offset, correlationId };

    let type = 'UNPARSEABLE';
    for (let attempt = 1; ; attempt++) {
      try {
        const message = parseTreasuryMessage(raw.value);
        type = message.type;
        const outcome = await this.apply.execute(message, raw, correlationId);
        this.metrics.treasuryMessage(type, outcome);
        this.logger.log(
          { ...where, messageId: message.messageId, type: message.type, outcome },
          'Treasury message processed',
        );
        return;
      } catch (error) {
        const failure = classifyFailure(error);
        const exhausted = attempt >= this.policy.maxAttempts;
        if (!failure.retryable || exhausted) {
          this.logger.error(
            { ...where, code: failure.code, attempt, err: error },
            'Dead-lettering treasury message',
          );
          await this.deadLetters.publish({
            original: raw,
            errorCode: failure.code,
            errorMessage: error instanceof Error ? error.message : String(error),
            attempts: attempt,
            correlationId,
          });
          this.metrics.treasuryMessage(type, 'DEAD_LETTERED');
          this.metrics.deadLetter(failure.code);
          return;
        }
        const delay = backoffDelay(this.policy, attempt);
        this.logger.warn(
          { ...where, code: failure.code, attempt, delay },
          'Retrying treasury message',
        );
        // Aborts on shutdown: the message is left uncommitted and redelivered after restart.
        await sleep(delay, undefined, { signal: this.shutdown.signal });
      }
    }
  }
}
