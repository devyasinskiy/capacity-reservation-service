import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { buildOpenApiDocument, configureApiApp } from './bootstrap';
import type { Env } from './config/env.schema';
import { createManagementApp } from './modules/observability/management';

async function bootstrap(): Promise<void> {
  const api = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  configureApiApp(api);
  const config = api.get<ConfigService<Env, true>>(ConfigService);

  const httpPort = config.get('HTTP_PORT', { infer: true });
  const management = await createManagementApp(
    api,
    buildOpenApiDocument(api, `http://localhost:${httpPort}`),
  );
  await api.listen(httpPort);
  await management.listen(config.get('MANAGEMENT_PORT', { infer: true }));
}

void bootstrap();
