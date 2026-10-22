import { randomUUID } from 'node:crypto';
import { DomainError } from '../../../shared/errors/domain-error';
import type { FxRate } from '../../../shared/money/fx-rate';
import type { Money } from '../../../shared/money/money';
import {
  IdempotencyKeyRace,
  type IdempotentResult,
  replayOrReject,
  requestHash,
} from './idempotency';
import { type CapacityMetrics, NO_METRICS } from './ports/capacity-metrics';
import type { CapacityStore, ProgramKey } from './ports/capacity-store';
import type { Clock } from './ports/clock';
import type { FxRateProvider } from './ports/fx-rate-provider';
import { type ReservationView, toReservationView } from './views';

/** Input to {@link ReserveCapacity}; `amount` is in the invoice currency. */
export interface ReserveCapacityCommand {
  readonly program: ProgramKey;
  readonly invoiceId: string;
  readonly amount: Money;
  readonly idempotencyKey?: string;
  readonly correlationId?: string;
}

/**
 * Reserve program capacity for an approved invoice.
 *
 * Ordering matters (ADR-005/006): idempotency fast path → FX quote (potential network I/O) →
 * short locked transaction that re-checks idempotency, decides in the domain, and persists the
 * reservation + ledger row + idempotency record atomically.
 */
export class ReserveCapacity {
  constructor(
    private readonly store: CapacityStore,
    private readonly fx: FxRateProvider,
    private readonly clock: Clock,
    private readonly fxMaxAgeMs: number,
    private readonly metrics: CapacityMetrics = NO_METRICS,
  ) {}

  /**
   * Reserves capacity, or replays the original result for a retried request.
   * @returns status 201 for a new reservation, 200 (or the stored status) for a replay.
   * @throws DomainError `PROGRAM_NOT_FOUND`, `FX_RATE_UNAVAILABLE`, `INSUFFICIENT_CAPACITY`,
   *   `RESERVATION_CONFLICT` (same invoice, different amount) or `IDEMPOTENCY_KEY_REUSED`.
   * @throws RetryableError on lock/statement timeouts or connection loss.
   */
  async execute(cmd: ReserveCapacityCommand): Promise<IdempotentResult<ReservationView>> {
    try {
      const result = await this.attempt(cmd);
      this.metrics.reservation(result.replayed ? 'replayed' : 'created');
      return result;
    } catch (error) {
      if (error instanceof DomainError) {
        this.metrics.reservation(
          error.code === 'INSUFFICIENT_CAPACITY' ? 'insufficient_capacity' : 'rejected',
        );
      }
      throw error;
    }
  }

  private async attempt(
    cmd: ReserveCapacityCommand,
    attempt = 0,
  ): Promise<IdempotentResult<ReservationView>> {
    const hash = requestHash({
      programId: cmd.program.programId,
      invoiceId: cmd.invoiceId,
      amountMinor: cmd.amount.minor.toString(),
      currency: cmd.amount.currency.code,
    });

    // 1. Replays must succeed even if the FX provider is down: answer them before quoting.
    const early = await this.tryReplay(cmd, hash);
    if (early) return early;

    // 2. Quote outside the lock.
    const rate = await this.quote(cmd);

    // 3. Decide and persist under the program lock.
    try {
      return await this.store.withLockedProgram(
        cmd.program,
        {
          source: 'HTTP',
          sourceRef: cmd.idempotencyKey ?? null,
          correlationId: cmd.correlationId ?? null,
        },
        async (session) => {
          if (cmd.idempotencyKey) {
            const record = await session.findIdempotencyRecord(cmd.idempotencyKey);
            if (record) return replayOrReject<ReservationView>(record, 'RESERVE', hash);
          }
          const existing = await session.findLiveLocalReservationByInvoice(cmd.invoiceId);
          if (existing)
            return replayExisting(existing.isSameRequest(cmd.amount), existing.toState());

          const { reservation, movement } = session.program.reserve({
            reservationId: randomUUID(),
            invoiceId: cmd.invoiceId,
            invoiceAmount: cmd.amount,
            fxRate: rate,
            now: this.clock.now(),
          });
          await session.saveReservation(reservation);
          await session.recordMovement(movement);

          const body = toReservationView(reservation.toState());
          if (cmd.idempotencyKey) {
            await session.saveIdempotencyRecord({
              key: cmd.idempotencyKey,
              operation: 'RESERVE',
              requestHash: hash,
              responseStatus: 201,
              responseBody: body,
            });
          }
          return { status: 201, body, replayed: false };
        },
      );
    } catch (error) {
      // Same key committed concurrently by a request for another program: replay it.
      if (error instanceof IdempotencyKeyRace && attempt === 0)
        return this.attempt(cmd, attempt + 1);
      throw error;
    }
  }

  private async tryReplay(
    cmd: ReserveCapacityCommand,
    hash: string,
  ): Promise<IdempotentResult<ReservationView> | null> {
    if (cmd.idempotencyKey) {
      const record = await this.store.findIdempotencyRecord(
        cmd.program.tenantId,
        cmd.idempotencyKey,
      );
      if (record) return replayOrReject<ReservationView>(record, 'RESERVE', hash);
    }
    const existing = await this.store.findLiveLocalReservationByInvoice(cmd.program, cmd.invoiceId);
    return existing ? replayExisting(existing.isSameRequest(cmd.amount), existing.toState()) : null;
  }

  private async quote(cmd: ReserveCapacityCommand): Promise<FxRate> {
    const program = await this.store.findProgram(cmd.program);
    if (!program) {
      throw new DomainError('PROGRAM_NOT_FOUND', 'Program not found', {
        programId: cmd.program.programId,
      });
    }
    const base = cmd.amount.currency.code;
    const quote = program.currencyCode;
    const rate = await this.fx.getRate(base, quote);
    if (!rate || !rate.isFresh(this.clock.now(), this.fxMaxAgeMs)) {
      throw new DomainError('FX_RATE_UNAVAILABLE', `No current FX rate for ${base}/${quote}`, {
        base,
        quote,
      });
    }
    return rate;
  }
}

/**
 * One live reservation per invoice (ADR-006): an identical retry gets the original back (200),
 * a different amount for the same invoice is a conflict.
 */
function replayExisting(
  sameRequest: boolean,
  state: Parameters<typeof toReservationView>[0],
): IdempotentResult<ReservationView> {
  if (!sameRequest) {
    throw new DomainError(
      'RESERVATION_CONFLICT',
      'A live reservation for this invoice exists with a different amount',
      { reservationId: state.id },
    );
  }
  return { status: 200, body: toReservationView(state), replayed: true };
}
