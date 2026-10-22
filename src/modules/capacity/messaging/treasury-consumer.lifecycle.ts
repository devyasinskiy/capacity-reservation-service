import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.schema';
import { TreasuryMessageListener } from './treasury-message.listener';

const RECONNECT_DELAY_MS = 5000;

/**
 * Nest lifecycle hooks around the framework-free listener. Starts after the app is fully
 * initialised (onApplicationBootstrap) and in the background: a Kafka outage at boot must not
 * stop the HTTP API from serving — readiness reports it instead. Stops first on SIGTERM so
 * in-flight messages finish (or stay uncommitted) before the DB pool closes.
 */
@Injectable()
export class TreasuryConsumerLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TreasuryConsumerLifecycle.name);
  private stopping = false;
  private retryTimer?: NodeJS.Timeout;

  constructor(
    private readonly listener: TreasuryMessageListener,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Starts the consumer in the background (with reconnect) unless disabled by config. */
  onApplicationBootstrap(): void {
    if (!this.config.get('KAFKA_CONSUMER_ENABLED', { infer: true })) {
      this.logger.log('Treasury consumer disabled (KAFKA_CONSUMER_ENABLED=false)');
      return;
    }
    this.startInBackground();
  }

  /** Cancels pending reconnects and stops the listener. */
  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.retryTimer);
    await this.listener.stop();
  }

  private startInBackground(): void {
    this.listener.start().catch((err: unknown) => {
      if (this.stopping) return;
      this.logger.error(
        { err },
        `Treasury consumer failed to start; retrying in ${RECONNECT_DELAY_MS}ms`,
      );
      this.retryTimer = setTimeout(() => this.startInBackground(), RECONNECT_DELAY_MS);
    });
  }
}
