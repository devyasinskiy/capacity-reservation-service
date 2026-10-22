import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.schema';
import { CAPACITY_STORE, type CapacityStore } from '../application/ports/capacity-store';
import { CLOCK, type Clock } from '../application/ports/clock';

/**
 * Discards incomplete chunked snapshots after SNAPSHOT_STAGING_TTL_SECONDS (ADR-020). The delete
 * is idempotent, so running on every instance needs no leader election.
 */
@Injectable()
export class SnapshotStagingSweeper implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SnapshotStagingSweeper.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(CAPACITY_STORE) private readonly store: CapacityStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Schedules the periodic sweep on instances that run the consumer. */
  onApplicationBootstrap(): void {
    if (!this.config.get('KAFKA_CONSUMER_ENABLED', { infer: true })) return;
    const everyMs = this.config.get('SNAPSHOT_SWEEP_INTERVAL_SECONDS', { infer: true }) * 1000;
    this.timer = setInterval(() => void this.sweep(), everyMs);
    this.timer.unref();
  }

  /** Stops the sweep timer. */
  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /**
   * Deletes staged parts older than the TTL. Never throws; failures are logged.
   * @returns number of parts deleted (0 on failure).
   */
  async sweep(): Promise<number> {
    const ttlMs = this.config.get('SNAPSHOT_STAGING_TTL_SECONDS', { infer: true }) * 1000;
    try {
      const deleted = await this.store.purgeStagedSnapshotParts(
        new Date(this.clock.now().getTime() - ttlMs),
      );
      if (deleted > 0) this.logger.warn({ deleted }, 'Discarded expired incomplete snapshot parts');
      return deleted;
    } catch (err) {
      this.logger.error({ err }, 'Snapshot staging sweep failed');
      return 0;
    }
  }
}
