import { Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { Client } from 'pg';
import { type Observable, Subject } from 'rxjs';

/** Postgres NOTIFY channel for committed capacity changes. */
export const CAPACITY_CHANNEL = 'capacity_changed';

/** `programId: '*'` means "re-read everything": emitted after (re)connecting, when NOTIFYs may have been missed. */
export interface AvailabilityChange {
  readonly tenantId: string;
  readonly programId: string;
  readonly version: string;
}

const RECONNECT_DELAY_MS = 2000;

/**
 * Fan-out of committed capacity changes via Postgres LISTEN/NOTIFY (ADR-014). Writers call
 * pg_notify inside their transaction; Postgres delivers only on COMMIT, so subscribers never see
 * uncommitted state, and it works across instances (whichever instance consumed the Kafka message).
 * One dedicated connection per instance (LISTEN cannot use a pooled connection).
 */
export class PgAvailabilityChanges implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PgAvailabilityChanges.name);
  private readonly subject = new Subject<AvailabilityChange>();
  private client?: Client;
  private stopped = false;
  private retry?: NodeJS.Timeout;

  readonly changes$: Observable<AvailabilityChange> = this.subject.asObservable();

  constructor(private readonly connectionString: string) {}

  /** Connects and LISTENs in the background; reconnects on failure. */
  onModuleInit(): void {
    void this.connect();
  }

  /** Completes the change stream and closes the LISTEN connection. */
  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    this.subject.complete();
    await this.client?.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    const client = new Client({
      connectionString: this.connectionString,
      application_name: 'program-capacity-listen',
    });
    this.client = client;
    client.on('notification', (msg) => {
      if (msg.channel !== CAPACITY_CHANNEL || !msg.payload) return;
      try {
        const change = JSON.parse(msg.payload) as AvailabilityChange;
        this.subject.next(change);
      } catch {
        this.logger.warn(
          { payload: msg.payload.slice(0, 200) },
          'Ignoring malformed capacity notification',
        );
      }
    });
    client.on('error', (err) => {
      this.logger.warn({ err }, 'LISTEN connection lost; reconnecting');
      this.scheduleReconnect();
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${CAPACITY_CHANNEL}`);
      this.subject.next({ tenantId: '*', programId: '*', version: '0' }); // resync after any gap
    } catch (err) {
      this.logger.warn({ err }, 'LISTEN connection failed; retrying');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retry) return;
    void this.client?.end().catch(() => undefined);
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.connect();
    }, RECONNECT_DELAY_MS);
    this.retry.unref();
  }
}
