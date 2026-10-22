import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { type Kysely, sql } from 'kysely';
import { KYSELY } from '../../shared/database/database';
import type { Database } from '../../shared/database/database.types';

const PING_TIMEOUT_MS = 1000;

/** Readiness: can we run a trivial query within a second? Error details stay in logs. */
@Injectable()
export class DatabaseHealthIndicator {
  constructor(
    private readonly indicators: HealthIndicatorService,
    @Inject(KYSELY) private readonly db: Kysely<Database>,
  ) {}

  /** Runs `select 1` with a 1 s timeout; reports `down` without error details on failure. */
  async check(key = 'database') {
    const indicator = this.indicators.check(key);
    try {
      await Promise.race([
        sql`select 1`.execute(this.db),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), PING_TIMEOUT_MS).unref(),
        ),
      ]);
      return indicator.up();
    } catch {
      return indicator.down({ message: 'unreachable' });
    }
  }
}
