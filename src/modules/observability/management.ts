import { type DynamicModule, type INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { TerminusModule } from '@nestjs/terminus';
import { Logger } from 'nestjs-pino';
import { KYSELY } from '../../shared/database/database';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import { TREASURY_MESSAGE_CONSUMER } from '../capacity/application/ports/treasury-messaging';
import { DatabaseHealthIndicator } from './database.health';
import { KAFKA_CONSUMER_ENABLED, KafkaHealthIndicator } from './kafka.health';
import { METRICS_REGISTRY, MetricsController } from './metrics.controller';
import { PrometheusMetrics } from './prometheus-metrics';
import { HealthController } from './health.controller';

@Module({})
class ManagementModule {
  /**
   * A dynamic module (forRoot pattern) lets us inject *instances* owned by the API app, so the
   * management app reuses the same DB pool instead of opening its own.
   */
  static forRoot(shared: {
    db: unknown;
    consumer: unknown;
    consumerEnabled: boolean;
    registry: unknown;
  }): DynamicModule {
    return {
      module: ManagementModule,
      imports: [TerminusModule],
      controllers: [HealthController, MetricsController],
      providers: [
        { provide: KYSELY, useValue: shared.db },
        { provide: TREASURY_MESSAGE_CONSUMER, useValue: shared.consumer },
        { provide: KAFKA_CONSUMER_ENABLED, useValue: shared.consumerEnabled },
        { provide: METRICS_REGISTRY, useValue: shared.registry },
        DatabaseHealthIndicator,
        KafkaHealthIndicator,
      ],
    };
  }
}

/**
 * Builds the internal management app (health, OpenAPI docs, /metrics) on its own port, so the
 * public API port exposes only JWT-protected endpoints (ADR-016).
 */
export async function createManagementApp(
  api: INestApplication,
  openApi?: OpenAPIObject,
): Promise<NestExpressApplication> {
  const management = await NestFactory.create<NestExpressApplication>(
    ManagementModule.forRoot({
      db: api.get(KYSELY),
      consumer: api.get(TREASURY_MESSAGE_CONSUMER),
      consumerEnabled: api
        .get<ConfigService<Env, true>>(ConfigService)
        .get('KAFKA_CONSUMER_ENABLED', { infer: true }),
      registry: api.get(PrometheusMetrics).registry,
    }),
    { logger: false },
  );
  management.useLogger(api.get(Logger));
  management.disable('x-powered-by');
  // Interactive docs live on the internal port so the public port has no unauthenticated routes.
  if (openApi)
    SwaggerModule.setup('docs', management, openApi, { jsonDocumentUrl: 'docs/openapi.json' });
  return management;
}
