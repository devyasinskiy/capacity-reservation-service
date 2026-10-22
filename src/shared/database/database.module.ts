import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Kysely } from 'kysely';
import type { Env } from '../../config/env.schema';
import { createDatabase, KYSELY } from './database';
import type { Database } from './database.types';

/**
 * Provides one Kysely instance (and its pg pool) app-wide. @Global so feature modules can inject
 * KYSELY without re-importing; a factory provider (useFactory + inject) builds it from validated
 * config. The pool is closed in onApplicationShutdown, after in-flight work has drained.
 */
@Global()
@Module({
  providers: [
    {
      provide: KYSELY,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const logger = new Logger('Database');
        return createDatabase(config.get('DATABASE_URL', { infer: true }), {
          poolMax: config.get('DB_POOL_MAX', { infer: true }),
          acquireTimeoutMs: config.get('DB_POOL_ACQUIRE_TIMEOUT_MS', { infer: true }),
          onPoolError: (err) => logger.error({ err }, 'Idle database connection error'),
        });
      },
    },
  ],
  exports: [KYSELY],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  /** Closes the pg pool once Nest has stopped accepting work. */
  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}
