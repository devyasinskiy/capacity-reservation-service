/**
 * Messaging ports (ADR-009): the application never imports a Kafka client. Any transport that
 * can deliver ordered messages per key and commit progress can implement these.
 */

/** A raw Kafka record as delivered to the handler; parsing happens in the listener. */
export interface InboundMessage {
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
  readonly key: string | null;
  readonly value: Buffer | null;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Contract: the consumer commits the message's offset only after `handler` resolves. If the
 * handler rejects, the offset is NOT committed and the message is redelivered (at-least-once).
 */
export type InboundMessageHandler = (message: InboundMessage) => Promise<void>;

/** Consumes the treasury topic, ordered per partition (= per program). */
export interface TreasuryMessageConsumer {
  /** Connects and begins delivering messages to `handler`. */
  start(handler: InboundMessageHandler): Promise<void>;
  /** Stops consuming and disconnects; in-flight handlers finish first. */
  stop(): Promise<void>;
  /** True while connected to the broker (readiness). */
  isConnected(): boolean;
  /** Messages behind the partition high watermark, per partition (for the lag gauge). */
  lag(): Promise<Array<{ partition: number; lag: number }>>;
}

/** A message that exhausted retries or is permanently invalid (ADR-012). */
export interface DeadLetter {
  readonly original: InboundMessage;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly attempts: number;
  readonly correlationId: string;
}

/** Publishes poison messages to the dead-letter topic. */
export interface DeadLetterPublisher {
  /** Must resolve only once the broker has durably accepted the message. */
  publish(letter: DeadLetter): Promise<void>;
}

/** DI token for {@link TreasuryMessageConsumer}. */
export const TREASURY_MESSAGE_CONSUMER = Symbol('TreasuryMessageConsumer');
/** DI token for {@link DeadLetterPublisher}. */
export const DEAD_LETTER_PUBLISHER = Symbol('DeadLetterPublisher');
