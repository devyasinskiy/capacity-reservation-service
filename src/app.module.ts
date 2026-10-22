import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { validateEnv } from './config/env.schema';
import { AuthModule } from './modules/auth/auth.module';
import { CapacityModule } from './modules/capacity/capacity.module';
import { MetricsModule } from './modules/observability/metrics.module';
import { KafkaModule } from './infrastructure/kafka/kafka.module';
import { DatabaseModule } from './shared/database/database.module';
import { ProblemDetailsFilter } from './shared/errors/problem-details.filter';
import { createValidationPipe } from './shared/errors/validation';
import { LoggingModule } from './shared/logging/logging.module';

/**
 * Root module: global config, logging, database, Kafka, metrics, auth and the capacity feature.
 * Installs the problem+json filter and validation pipe app-wide.
 */
@Module({
  imports: [
    // isGlobal: ConfigService is injectable everywhere without re-importing ConfigModule.
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    LoggingModule,
    DatabaseModule,
    KafkaModule,
    MetricsModule,
    AuthModule,
    CapacityModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    { provide: APP_PIPE, useFactory: createValidationPipe },
  ],
})
export class AppModule {}
