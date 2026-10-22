import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Kysely } from 'kysely';
import type { Env } from '../../config/env.schema';
import { KYSELY } from '../../shared/database/database';
import type { Database } from '../../shared/database/database.types';
import { ApplyTreasuryMessage } from './application/apply-treasury-message';
import { CAPACITY_METRICS, type CapacityMetrics } from './application/ports/capacity-metrics';
import { CAPACITY_READ_MODEL } from './application/ports/capacity-read-model';
import { CAPACITY_STORE, type CapacityStore } from './application/ports/capacity-store';
import { CLOCK, type Clock } from './application/ports/clock';
import { FX_RATE_PROVIDER, type FxRateProvider } from './application/ports/fx-rate-provider';
import {
  DEAD_LETTER_PUBLISHER,
  type DeadLetterPublisher,
  TREASURY_MESSAGE_CONSUMER,
  type TreasuryMessageConsumer,
} from './application/ports/treasury-messaging';
import { ReleaseReservation } from './application/release-reservation';
import { ReserveCapacity } from './application/reserve-capacity';
import { AvailabilityStreamController } from './http/availability-stream.controller';
import { ProgramsController } from './http/programs.controller';
import { ReservationsController } from './http/reservations.controller';
import { StubFxRateProvider } from './infrastructure/fx/stub-fx-rate-provider';
import { PgAvailabilityChanges } from './infrastructure/notifications/pg-availability-changes';
import { KyselyCapacityReadModel } from './infrastructure/persistence/kysely-capacity-read-model';
import { KyselyCapacityStore } from './infrastructure/persistence/kysely-capacity-store';
import { SnapshotStagingSweeper } from './messaging/snapshot-staging.sweeper';
import { TreasuryConsumerLifecycle } from './messaging/treasury-consumer.lifecycle';
import { TreasuryMessageListener } from './messaging/treasury-message.listener';

const systemClock: Clock = { now: () => new Date() };

/**
 * Wires application ports (Symbol tokens) to infrastructure adapters. Use cases are plain classes
 * built by factory providers, so they carry no Nest decorators and stay framework-free; swapping
 * the stub FX provider for a real one is a one-line provider change here.
 */
@Module({
  controllers: [ProgramsController, ReservationsController, AvailabilityStreamController],
  providers: [
    { provide: CLOCK, useValue: systemClock },
    {
      provide: FX_RATE_PROVIDER,
      inject: [CLOCK],
      useFactory: (clock: Clock) => new StubFxRateProvider(clock),
    },
    {
      provide: CAPACITY_STORE,
      inject: [KYSELY, ConfigService],
      useFactory: (db: Kysely<Database>, config: ConfigService<Env, true>) =>
        new KyselyCapacityStore(db, {
          lockTimeoutMs: config.get('DB_LOCK_TIMEOUT_MS', { infer: true }),
          statementTimeoutMs: config.get('DB_STATEMENT_TIMEOUT_MS', { infer: true }),
        }),
    },
    {
      provide: CAPACITY_READ_MODEL,
      inject: [KYSELY],
      useFactory: (db: Kysely<Database>) => new KyselyCapacityReadModel(db),
    },
    {
      provide: ReserveCapacity,
      inject: [CAPACITY_STORE, FX_RATE_PROVIDER, CLOCK, ConfigService, CAPACITY_METRICS],
      useFactory: (
        store: CapacityStore,
        fx: FxRateProvider,
        clock: Clock,
        config: ConfigService<Env, true>,
        metrics: CapacityMetrics,
      ) =>
        new ReserveCapacity(
          store,
          fx,
          clock,
          config.get('FX_MAX_AGE_SECONDS', { infer: true }) * 1000,
          metrics,
        ),
    },
    {
      provide: ReleaseReservation,
      inject: [CAPACITY_STORE, CAPACITY_METRICS],
      useFactory: (store: CapacityStore, metrics: CapacityMetrics) =>
        new ReleaseReservation(store, metrics),
    },
    {
      provide: ApplyTreasuryMessage,
      inject: [CAPACITY_STORE, ConfigService, CAPACITY_METRICS],
      useFactory: (
        store: CapacityStore,
        config: ConfigService<Env, true>,
        metrics: CapacityMetrics,
      ) =>
        new ApplyTreasuryMessage(store, {
          graceWindowMs: config.get('RECONCILIATION_GRACE_WINDOW_SECONDS', { infer: true }) * 1000,
          metrics,
        }),
    },
    {
      provide: TreasuryMessageListener,
      inject: [
        TREASURY_MESSAGE_CONSUMER,
        ApplyTreasuryMessage,
        DEAD_LETTER_PUBLISHER,
        ConfigService,
        CAPACITY_METRICS,
      ],
      useFactory: (
        consumer: TreasuryMessageConsumer,
        apply: ApplyTreasuryMessage,
        dlq: DeadLetterPublisher,
        config: ConfigService<Env, true>,
        metrics: CapacityMetrics,
      ) =>
        new TreasuryMessageListener(
          consumer,
          apply,
          dlq,
          {
            maxAttempts: config.get('KAFKA_RETRY_MAX_ATTEMPTS', { infer: true }),
            initialDelayMs: config.get('KAFKA_RETRY_INITIAL_MS', { infer: true }),
            maxDelayMs: config.get('KAFKA_RETRY_MAX_MS', { infer: true }),
          },
          metrics,
        ),
    },
    {
      provide: PgAvailabilityChanges,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new PgAvailabilityChanges(config.get('DATABASE_URL', { infer: true })),
    },
    TreasuryConsumerLifecycle,
    SnapshotStagingSweeper,
  ],
  exports: [CAPACITY_STORE, CAPACITY_READ_MODEL, FX_RATE_PROVIDER, CLOCK, ApplyTreasuryMessage],
})
export class CapacityModule {}
