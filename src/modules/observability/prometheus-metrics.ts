import type { NextFunction, Request, Response } from 'express';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type {
  CapacityMetrics,
  ReconciliationMetrics,
} from '../capacity/application/ports/capacity-metrics';
import type { TreasuryMessageConsumer } from '../capacity/application/ports/treasury-messaging';

/**
 * All Prometheus instruments in one place, on a dedicated registry (not the prom-client global),
 * scraped from the management port (ADR-016). Label values are bounded enums only — never ids.
 */
export class PrometheusMetrics implements CapacityMetrics {
  readonly registry = new Registry();

  private readonly reservations = new Counter({
    name: 'capacity_reservations_total',
    help: 'Reservation requests by result (created | replayed | insufficient_capacity | rejected)',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });
  private readonly insufficient = new Counter({
    name: 'capacity_insufficient_capacity_rejections_total',
    help: 'Reservations rejected because the program had no room',
    registers: [this.registry],
  });
  private readonly releases = new Counter({
    name: 'capacity_releases_total',
    help: 'Release requests by result (released | replayed | rejected)',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });
  private readonly messages = new Counter({
    name: 'treasury_messages_total',
    help: 'Treasury messages processed, by type and outcome',
    labelNames: ['type', 'outcome'] as const,
    registers: [this.registry],
  });
  private readonly deadLetters = new Counter({
    name: 'treasury_dead_letters_total',
    help: 'Treasury messages sent to the DLQ, by error code',
    labelNames: ['code'] as const,
    registers: [this.registry],
  });
  private readonly reconciliationRuns = new Counter({
    name: 'reconciliation_runs_total',
    help: 'Applied reconciliation snapshots, by whether their limit was applied',
    labelNames: ['limit_applied'] as const,
    registers: [this.registry],
  });
  private readonly discrepancies = new Counter({
    name: 'reconciliation_discrepancies_total',
    help: 'Discrepancy transitions per run: uncertain (no strike), pending (1st), opened (flagged), cleared',
    labelNames: ['transition'] as const,
    registers: [this.registry],
  });
  private readonly overLimit = new Counter({
    name: 'capacity_over_limit_transitions_total',
    help: 'Treasury-driven changes that pushed a program over its limit (ADR-013)',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });
  readonly httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Public API request latency',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  constructor(consumer?: TreasuryMessageConsumer) {
    collectDefaultMetrics({ register: this.registry });
    if (consumer) {
      new Gauge({
        name: 'treasury_consumer_lag',
        help: 'Messages between the committed offset and the high watermark, per partition',
        labelNames: ['partition'] as const,
        registers: [this.registry],
        // Computed on scrape; a broker hiccup must not fail the whole /metrics response.
        async collect() {
          try {
            this.reset();
            for (const { partition, lag } of await consumer.lag())
              this.set({ partition: String(partition) }, lag);
          } catch {
            // leave the gauge empty for this scrape
          }
        },
      });
    }
  }

  /** Counts a reserve outcome; also bumps the insufficient-capacity counter. */
  reservation(result: Parameters<CapacityMetrics['reservation']>[0]): void {
    this.reservations.inc({ result });
    if (result === 'insufficient_capacity') this.insufficient.inc();
  }

  /** Counts a release outcome. */
  release(result: Parameters<CapacityMetrics['release']>[0]): void {
    this.releases.inc({ result });
  }

  /** Counts a consumed treasury message by type and outcome. */
  treasuryMessage(type: string, outcome: string): void {
    this.messages.inc({ type, outcome });
  }

  /** Counts a message sent to the DLQ, by error code. */
  deadLetter(code: string): void {
    this.deadLetters.inc({ code });
  }

  /** Counts a reconciliation run and its discrepancy transitions. */
  reconciliation(run: ReconciliationMetrics): void {
    this.reconciliationRuns.inc({ limit_applied: String(run.limitApplied) });
    this.discrepancies.inc({ transition: 'uncertain' }, run.uncertain);
    this.discrepancies.inc({ transition: 'pending' }, run.pending);
    this.discrepancies.inc({ transition: 'opened' }, run.opened);
    this.discrepancies.inc({ transition: 'cleared' }, run.cleared);
  }

  /** Counts a treasury-driven transition into over-limit (ADR-013). */
  overLimitTransition(source: Parameters<CapacityMetrics['overLimitTransition']>[0]): void {
    this.overLimit.inc({ source });
  }

  /** Express middleware: route template (not the raw URL) keeps label cardinality bounded. */
  httpMiddleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      const end = this.httpDuration.startTimer({ method: req.method });
      res.on('finish', () => {
        const route = (req.route as { path?: string } | undefined)?.path ?? 'unmatched';
        end({ route, status: String(res.statusCode) });
      });
      next();
    };
  }
}
