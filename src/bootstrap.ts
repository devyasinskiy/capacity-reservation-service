import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import type { Env } from './config/env.schema';
import { PrometheusMetrics } from './modules/observability/prometheus-metrics';
import { runWithCorrelationId } from './shared/context/correlation-context';
import { CORRELATION_ID_HEADER, resolveCorrelationId } from './shared/context/correlation-id';

/** Cross-cutting HTTP setup shared by main.ts and e2e tests so tests exercise the real config. */
export function configureApiApp(app: NestExpressApplication): void {
  // First middleware: resolve the correlation id once and run the rest of the request inside its
  // async context, so logs, ledger rows and problem bodies all agree (ADR-018).
  app.use((req: Request & { id?: string }, res: Response, next: NextFunction) => {
    const id = resolveCorrelationId(req.headers[CORRELATION_ID_HEADER]);
    req.id = id;
    res.setHeader(CORRELATION_ID_HEADER, id);
    runWithCorrelationId(id, next);
  });
  app.use(app.get(PrometheusMetrics).httpMiddleware());
  app.useLogger(app.get(Logger));
  app.disable('x-powered-by');
  app.setGlobalPrefix('v1');
  // Explicit, small body limit: requests are tiny; anything larger is a client bug or abuse.
  app.useBodyParser('json', { limit: '32kb' });
  // Runs onModuleDestroy/onApplicationShutdown on SIGTERM so Kafka/DB can drain gracefully.
  app.enableShutdownHooks();

  const origins = app
    .get<ConfigService<Env, true>>(ConfigService)
    .get('CORS_ORIGINS', { infer: true });
  if (origins.length > 0) {
    app.enableCors({
      origin: origins,
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', CORRELATION_ID_HEADER],
      exposedHeaders: ['Location', 'Idempotent-Replayed', 'Retry-After', CORRELATION_ID_HEADER],
    });
  }
}

/** OpenAPI document for the public API. Served from the management port (ADR-016). */
export function buildOpenApiDocument(
  app: NestExpressApplication,
  apiBaseUrl: string,
): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Program Capacity API')
    .setDescription(
      'Tracks financing-program capacity: reserve on invoice approval, release on repayment, ' +
        'read availability. Money is integer minor units as strings + ISO 4217 code. ' +
        'Errors are RFC 9457 problem+json with a stable `code`. All endpoints require a bearer JWT.',
    )
    .setVersion('1.0')
    .addServer(apiBaseUrl)
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .build();
  return SwaggerModule.createDocument(app, config);
}
