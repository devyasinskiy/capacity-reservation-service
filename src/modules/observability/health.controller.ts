import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { DatabaseHealthIndicator } from './database.health';
import { KafkaHealthIndicator } from './kafka.health';

/** Served on the internal management port only (ADR-016). */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: DatabaseHealthIndicator,
    private readonly kafka: KafkaHealthIndicator,
  ) {}

  /** Liveness: the process is up and the event loop responds. Never checks dependencies. */
  @Get('live')
  @HealthCheck()
  live() {
    return this.health.check([]);
  }

  /** Readiness: dependencies reachable; 503 takes the instance out of rotation. */
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([() => this.database.check(), () => this.kafka.check()]);
  }
}
