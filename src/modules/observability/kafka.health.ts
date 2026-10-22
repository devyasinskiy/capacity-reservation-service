import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import {
  TREASURY_MESSAGE_CONSUMER,
  type TreasuryMessageConsumer,
} from '../capacity/application/ports/treasury-messaging';

/** DI token: whether this instance runs the treasury consumer (`KAFKA_CONSUMER_ENABLED`). */
export const KAFKA_CONSUMER_ENABLED = Symbol('KafkaConsumerEnabled');

/** Readiness: the treasury consumer is connected (or deliberately disabled on this instance). */
@Injectable()
export class KafkaHealthIndicator {
  constructor(
    private readonly indicators: HealthIndicatorService,
    @Inject(TREASURY_MESSAGE_CONSUMER) private readonly consumer: TreasuryMessageConsumer,
    @Inject(KAFKA_CONSUMER_ENABLED) private readonly enabled: boolean,
  ) {}

  /** Up if the consumer is connected or disabled on this instance; down otherwise. */
  check(key = 'kafka') {
    const indicator = this.indicators.check(key);
    if (!this.enabled) return indicator.up({ consumer: 'disabled' });
    return this.consumer.isConnected()
      ? indicator.up()
      : indicator.down({ message: 'consumer not connected' });
  }
}
