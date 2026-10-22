import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import type { Env } from '../../config/env.schema';
import { currentCorrelationId } from '../context/correlation-context';
import { CORRELATION_ID_HEADER, resolveCorrelationId } from '../context/correlation-id';

/**
 * Structured JSON logs via pino. `forRootAsync` + `inject` is the Nest idiom for building a
 * module's options from another provider (here: validated config) at bootstrap time.
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          transport: config.get('LOG_PRETTY', { infer: true })
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
          // The correlation middleware (bootstrap.ts) runs first and already resolved the id.
          genReqId: (req, res) => {
            const existing = (req as { id?: unknown }).id;
            const id =
              typeof existing === 'string'
                ? existing
                : resolveCorrelationId(req.headers[CORRELATION_ID_HEADER]);
            res.setHeader(CORRELATION_ID_HEADER, id);
            return id;
          },
          // Every log line — HTTP or Kafka path — carries the current correlation id (ADR-018).
          mixin: () => {
            const correlationId = currentCorrelationId();
            return correlationId ? { correlationId } : {};
          },
          customAttributeKeys: { reqId: 'correlationId' },
          redact: {
            paths: ['req.headers.authorization', 'req.headers.cookie'],
            censor: '[redacted]',
          },
        },
      }),
    }),
  ],
})
export class LoggingModule {}
