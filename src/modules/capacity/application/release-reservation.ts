import { DomainError } from '../../../shared/errors/domain-error';
import type { Money } from '../../../shared/money/money';
import {
  IdempotencyKeyRace,
  type IdempotentResult,
  replayOrReject,
  requestHash,
} from './idempotency';
import { type CapacityMetrics, NO_METRICS } from './ports/capacity-metrics';
import type { CapacityStore, ProgramKey } from './ports/capacity-store';
import { moneyView, type ReleaseView, toReservationView } from './views';

/** Input to {@link ReleaseReservation}. */
export interface ReleaseReservationCommand {
  readonly program: ProgramKey;
  readonly reservationId: string;
  /** Invoice currency; omitted = release the outstanding remainder (ADR-004). */
  readonly amount?: Money;
  /** Required: partial releases are not naturally idempotent (ADR-006). */
  readonly idempotencyKey: string;
  readonly correlationId?: string;
}

/**
 * Releases (part of) a LOCAL reservation under the program lock, freeing exactly the locked
 * program-currency share (ADR-004). Keyed by a mandatory Idempotency-Key (ADR-006).
 */
export class ReleaseReservation {
  constructor(
    private readonly store: CapacityStore,
    private readonly metrics: CapacityMetrics = NO_METRICS,
  ) {}

  /**
   * Releases capacity, or replays the stored result for a retried Idempotency-Key.
   * @throws DomainError `RESERVATION_NOT_FOUND`, `RESERVATION_ALREADY_RELEASED`, `OVER_RELEASE`,
   *   `RESERVATION_MANAGED_EXTERNALLY`, `CURRENCY_MISMATCH` or `IDEMPOTENCY_KEY_REUSED`.
   * @throws RetryableError on lock/statement timeouts or connection loss.
   */
  async execute(cmd: ReleaseReservationCommand): Promise<IdempotentResult<ReleaseView>> {
    try {
      const result = await this.attempt(cmd);
      this.metrics.release(result.replayed ? 'replayed' : 'released');
      return result;
    } catch (error) {
      if (error instanceof DomainError) this.metrics.release('rejected');
      throw error;
    }
  }

  private async attempt(
    cmd: ReleaseReservationCommand,
    attempt = 0,
  ): Promise<IdempotentResult<ReleaseView>> {
    const hash = requestHash({
      programId: cmd.program.programId,
      reservationId: cmd.reservationId,
      amountMinor: cmd.amount?.minor.toString(),
      currency: cmd.amount?.currency.code,
    });

    const prior = await this.store.findIdempotencyRecord(cmd.program.tenantId, cmd.idempotencyKey);
    if (prior) return replayOrReject<ReleaseView>(prior, 'RELEASE', hash);

    try {
      return await this.store.withLockedProgram(
        cmd.program,
        { source: 'HTTP', sourceRef: cmd.idempotencyKey, correlationId: cmd.correlationId ?? null },
        async (session) => {
          const record = await session.findIdempotencyRecord(cmd.idempotencyKey);
          if (record) return replayOrReject<ReleaseView>(record, 'RELEASE', hash);

          const reservation = await session.findReservation(cmd.reservationId);
          if (!reservation) {
            throw new DomainError('RESERVATION_NOT_FOUND', 'Reservation not found', {
              reservationId: cmd.reservationId,
            });
          }
          if (reservation.toState().origin === 'EXTERNAL') {
            // Treasury owns external reservations; they are released only via Kafka (ADR-013).
            throw new DomainError(
              'RESERVATION_MANAGED_EXTERNALLY',
              'This reservation is managed by treasury and cannot be released via the API',
            );
          }

          const outcome = session.program.release(reservation, cmd.amount);
          await session.saveReservation(reservation);
          await session.recordMovement(outcome.movement);

          const body: ReleaseView = {
            reservation: toReservationView(reservation.toState()),
            release: {
              releasedInvoiceAmount: moneyView(outcome.releasedInvoice),
              freedProgramAmount: moneyView(outcome.freedProgram),
            },
          };
          await session.saveIdempotencyRecord({
            key: cmd.idempotencyKey,
            operation: 'RELEASE',
            requestHash: hash,
            responseStatus: 200,
            responseBody: body,
          });
          return { status: 200, body, replayed: false };
        },
      );
    } catch (error) {
      if (error instanceof IdempotencyKeyRace && attempt === 0)
        return this.attempt(cmd, attempt + 1);
      throw error;
    }
  }
}
