import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import { CAPACITY_METRICS } from '../capacity/application/ports/capacity-metrics';
import {
  TREASURY_MESSAGE_CONSUMER,
  type TreasuryMessageConsumer,
} from '../capacity/application/ports/treasury-messaging';
import { PrometheusMetrics } from './prometheus-metrics';

/** One PrometheusMetrics per app, also exposed as the application's CapacityMetrics port. */
@Global()
@Module({
  providers: [
    {
      provide: PrometheusMetrics,
      inject: [TREASURY_MESSAGE_CONSUMER, ConfigService],
      useFactory: (consumer: TreasuryMessageConsumer, config: ConfigService<Env, true>) =>
        new PrometheusMetrics(
          config.get('KAFKA_CONSUMER_ENABLED', { infer: true }) ? consumer : undefined,
        ),
    },
    { provide: CAPACITY_METRICS, useExisting: PrometheusMetrics },
  ],
  exports: [PrometheusMetrics, CAPACITY_METRICS],
})
export class MetricsModule {}
