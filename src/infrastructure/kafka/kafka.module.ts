import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import {
  DEAD_LETTER_PUBLISHER,
  TREASURY_MESSAGE_CONSUMER,
} from '../../modules/capacity/application/ports/treasury-messaging';
import { ConfluentTreasuryKafka } from './confluent-kafka';

const KAFKA_CLIENT = Symbol('ConfluentTreasuryKafka');

/**
 * One Kafka client serving two ports (consumer + DLQ publisher). Exposed under the port tokens
 * only, so swapping in a kafkajs adapter (ADR-009 fallback) is a change in this file alone.
 */
@Global()
@Module({
  providers: [
    {
      provide: KAFKA_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new ConfluentTreasuryKafka({
          brokers: config.get('KAFKA_BROKERS', { infer: true }),
          clientId: config.get('KAFKA_CLIENT_ID', { infer: true }),
          groupId: config.get('KAFKA_GROUP_ID', { infer: true }),
          topic: config.get('KAFKA_TREASURY_TOPIC', { infer: true }),
          dlqTopic: config.get('KAFKA_DLQ_TOPIC', { infer: true }),
          partitionsConsumedConcurrently: config.get('KAFKA_PARTITIONS_CONCURRENCY', {
            infer: true,
          }),
        }),
    },
    { provide: TREASURY_MESSAGE_CONSUMER, useExisting: KAFKA_CLIENT },
    { provide: DEAD_LETTER_PUBLISHER, useExisting: KAFKA_CLIENT },
  ],
  exports: [TREASURY_MESSAGE_CONSUMER, DEAD_LETTER_PUBLISHER],
})
export class KafkaModule {}
