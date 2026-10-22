import { KafkaJS } from '@confluentinc/kafka-javascript';
import { Logger } from '@nestjs/common';
import type {
  DeadLetter,
  DeadLetterPublisher,
  InboundMessage,
  InboundMessageHandler,
  TreasuryMessageConsumer,
} from '../../modules/capacity/application/ports/treasury-messaging';

/** Connection and topic settings for {@link ConfluentTreasuryKafka}. */
export interface KafkaSettings {
  readonly brokers: string[];
  readonly clientId: string;
  readonly groupId: string;
  readonly topic: string;
  readonly dlqTopic: string;
  /** Different partitions (= different programs) in parallel; order within a partition kept. */
  readonly partitionsConsumedConcurrently: number;
}

const MAX_ERROR_HEADER = 500;

/**
 * Adapter over @confluentinc/kafka-javascript's KafkaJS-compatible API (ADR-009).
 * at-least-once: autoCommit is off; the offset (next = offset + 1) is committed only after the
 * handler resolved, i.e. after the DB transaction committed or the message reached the DLQ.
 */
export class ConfluentTreasuryKafka implements TreasuryMessageConsumer, DeadLetterPublisher {
  private readonly logger = new Logger('Kafka');
  private readonly kafka: KafkaJS.Kafka;
  private consumer?: KafkaJS.Consumer;
  private producer?: KafkaJS.Producer;
  private admin?: KafkaJS.Admin;
  private connected = false;

  constructor(private readonly settings: KafkaSettings) {
    this.kafka = new KafkaJS.Kafka({
      kafkaJS: {
        brokers: settings.brokers,
        clientId: settings.clientId,
        logLevel: KafkaJS.logLevel.WARN,
        logger: this.bridgeLogger(),
      },
    });
  }

  /**
   * Connects the DLQ producer and consumer, subscribes to the treasury topic and starts
   * consuming with manual offset commits.
   * @param handler Invoked per message; its offset is committed only after it resolves.
   */
  async start(handler: InboundMessageHandler): Promise<void> {
    this.producer = this.kafka.producer({ kafkaJS: { acks: -1, idempotent: true } });
    await this.producer.connect();

    const consumer = this.kafka.consumer({
      kafkaJS: { groupId: this.settings.groupId, fromBeginning: true, autoCommit: false },
    });
    this.consumer = consumer;
    await consumer.connect();
    await consumer.subscribe({ topics: [this.settings.topic] });
    await consumer.run({
      partitionsConsumedConcurrently: this.settings.partitionsConsumedConcurrently,
      eachMessage: async ({ topic, partition, message }) => {
        const inbound: InboundMessage = {
          topic,
          partition,
          offset: message.offset,
          key: message.key?.toString('utf8') ?? null,
          value: message.value,
          headers: decodeHeaders(message.headers),
        };
        try {
          await handler(inbound);
        } catch (error) {
          // Not committed: rewind so this exact message is redelivered (never skipped).
          this.logger.error(
            { topic, partition, offset: message.offset, err: error },
            'Handler failed; will redeliver',
          );
          consumer.seek({ topic, partition, offset: message.offset });
          return;
        }
        await consumer.commitOffsets([
          { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
        ]);
      },
    });
    this.connected = true;
    this.logger.log(
      { topic: this.settings.topic, groupId: this.settings.groupId },
      'Treasury consumer started',
    );
  }

  /** Disconnects consumer, producer and admin; errors are logged, never thrown. */
  async stop(): Promise<void> {
    this.connected = false;
    await this.consumer
      ?.disconnect()
      .catch((err: unknown) => this.logger.warn({ err }, 'Consumer disconnect failed'));
    await this.producer
      ?.disconnect()
      .catch((err: unknown) => this.logger.warn({ err }, 'Producer disconnect failed'));
    await this.admin?.disconnect().catch(() => undefined);
    this.admin = undefined;
  }

  /** True while the consumer is connected and running. */
  isConnected(): boolean {
    return this.connected;
  }

  /** Committed group offset vs high watermark per partition, via a lazily connected admin. */
  async lag(): Promise<Array<{ partition: number; lag: number }>> {
    if (!this.connected) return [];
    if (!this.admin) {
      this.admin = this.kafka.admin();
      await this.admin.connect();
    }
    const [committed, latest] = await Promise.all([
      this.admin.fetchOffsets({
        groupId: this.settings.groupId,
        topics: [this.settings.topic],
        timeout: 2000,
      }),
      this.admin.fetchTopicOffsets(this.settings.topic, {
        timeout: 2000,
        isolationLevel: KafkaJS.IsolationLevel.READ_COMMITTED,
      }),
    ]);
    const committedBy = new Map(
      committed[0]?.partitions.map((p) => [p.partition, BigInt(p.offset)]) ?? [],
    );
    return latest.map(({ partition, high }) => {
      const done = committedBy.get(partition) ?? -1n;
      const from = done < 0n ? 0n : done; // -1 = nothing committed yet
      return { partition, lag: Number(BigInt(high) - from) };
    });
  }

  /**
   * Publishes the original key, value and headers to the DLQ topic, plus `x-*` headers
   * describing the failure and origin. Resolves once all in-sync replicas acked (acks=-1).
   * @throws Error if the producer has not been started.
   */
  async publish(letter: DeadLetter): Promise<void> {
    if (!this.producer) throw new Error('DLQ producer not started');
    const { original } = letter;
    await this.producer.send({
      topic: this.settings.dlqTopic,
      messages: [
        {
          key: original.key,
          value: original.value,
          headers: {
            ...original.headers,
            'x-error-code': letter.errorCode,
            'x-error-message': letter.errorMessage.slice(0, MAX_ERROR_HEADER),
            'x-original-topic': original.topic,
            'x-original-partition': String(original.partition),
            'x-original-offset': original.offset,
            'x-attempts': String(letter.attempts),
            'x-correlation-id': letter.correlationId,
            'x-failed-at': new Date().toISOString(),
          },
        },
      ],
    });
  }

  private bridgeLogger(): KafkaJS.Logger {
    const logger = this.logger;
    const bridge: KafkaJS.Logger = {
      info: (msg, extra) => logger.log({ ...extra }, msg),
      warn: (msg, extra) => logger.warn({ ...extra }, msg),
      error: (msg, extra) => logger.error({ ...extra }, msg),
      debug: (msg, extra) => logger.debug({ ...extra }, msg),
      namespace: () => bridge,
      setLogLevel: () => undefined,
    };
    return bridge;
  }
}

function decodeHeaders(headers: KafkaJS.IHeaders | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    const first = Array.isArray(v) ? v[0] : v;
    if (first !== undefined) out[k] = first.toString();
  }
  return out;
}
