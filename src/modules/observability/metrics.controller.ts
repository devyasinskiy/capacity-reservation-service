import { Controller, Get, Header, Inject } from '@nestjs/common';
import type { Registry } from 'prom-client';

/** DI token for the prom-client registry served by {@link MetricsController}. */
export const METRICS_REGISTRY = Symbol('MetricsRegistry');

/** Prometheus scrape endpoint — management port only (ADR-016). */
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS_REGISTRY) private readonly registry: Registry) {}

  /** Prometheus text exposition of all registered metrics. */
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  metrics(): Promise<string> {
    return this.registry.metrics();
  }
}
