import type { Server } from 'node:http';
import type { INestApplication, Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureApiApp } from '../../src/bootstrap';
import {
  CAPACITY_STORE,
  type CapacityStore,
} from '../../src/modules/capacity/application/ports/capacity-store';
import { Program } from '../../src/modules/capacity/domain/program';
import { Money } from '../../src/shared/money/money';
import { uniqueTenant } from './db';

/** Full API app exactly as main.ts configures it (guards, pipes, filter, body limit). */
export async function createApiApp(
  extraControllers: Type[] = [],
  customize: (builder: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
): Promise<NestExpressApplication> {
  const moduleRef = await customize(
    Test.createTestingModule({ imports: [AppModule], controllers: extraControllers }),
  ).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
  configureApiApp(app);
  await app.init();
  return app;
}

export const http = (app: INestApplication): Server => app.getHttpServer() as Server;

/** Creates a program for a fresh tenant through the real store (with its opening ledger row). */
export async function givenProgram(
  app: INestApplication,
  opts: { currency?: string; limitMinor?: bigint; programId?: string; tenantId?: string } = {},
): Promise<{ tenantId: string; programId: string }> {
  const key = { tenantId: opts.tenantId ?? uniqueTenant(), programId: opts.programId ?? 'PRG-1' };
  const { program, movement } = Program.open({
    ...key,
    limit: Money.of(opts.limitMinor ?? 1_000_000n, opts.currency ?? 'USD'),
    version: 1n,
  });
  await app
    .get<CapacityStore>(CAPACITY_STORE)
    .createProgram(program, movement, { source: 'SYSTEM' });
  return key;
}
