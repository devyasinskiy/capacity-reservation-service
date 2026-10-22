import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Money } from '../../../shared/money/money';
import { CurrentPrincipal, RequireScopes } from '../../auth/decorators';
import type { Principal } from '../../auth/principal';
import { Scope } from '../../auth/scopes';
import type { IdempotentResult } from '../application/idempotency';
import {
  CAPACITY_READ_MODEL,
  type CapacityReadModel,
} from '../application/ports/capacity-read-model';
import { ReleaseReservation } from '../application/release-reservation';
import { ReserveCapacity } from '../application/reserve-capacity';
import type { Page, ReleaseView, ReservationView } from '../application/views';
import {
  ListReservationsQueryDto,
  ProgramParamsDto,
  ReleaseRequestDto,
  ReservationParamsDto,
  ReserveRequestDto,
} from './dto';
import {
  ProblemModel,
  ReleaseModel,
  ReservationModel,
  ReservationPageModel,
} from './openapi.models';
import { CorrelationId, parseIdempotencyKey } from './request-context';

/**
 * Reserve, release and read reservations of one program. Sets `Idempotent-Replayed: true` on
 * replayed responses.
 */
@ApiTags('reservations')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: ProblemModel, description: 'VALIDATION_FAILED, INVALID_AMOUNT' })
@ApiNotFoundResponse({
  type: ProblemModel,
  description: 'PROGRAM_NOT_FOUND, RESERVATION_NOT_FOUND',
})
@ApiForbiddenResponse({ type: ProblemModel, description: 'INSUFFICIENT_SCOPE' })
@Controller('programs/:programId/reservations')
export class ReservationsController {
  constructor(
    private readonly reserveCapacity: ReserveCapacity,
    private readonly releaseReservation: ReleaseReservation,
    @Inject(CAPACITY_READ_MODEL) private readonly readModel: CapacityReadModel,
  ) {}

  /**
   * `POST /programs/:programId/reservations` — reserve capacity (`capacity:write`).
   * Responds 201 with `Location` for a new reservation, 200 for a replay.
   */
  @Post()
  @RequireScopes(Scope.WRITE)
  @ApiOperation({
    summary: 'Reserve capacity for an approved invoice',
    description:
      'Converts the invoice amount to program currency at a locked FX rate (rounded up). ' +
      'Retrying with the same invoice + amount, or the same Idempotency-Key, returns the original reservation.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Client-generated key; replays the stored response',
  })
  @ApiCreatedResponse({ type: ReservationModel, description: 'Reserved' })
  @ApiOkResponse({
    type: ReservationModel,
    description: 'Replay of an existing identical reservation',
  })
  @ApiConflictResponse({
    type: ProblemModel,
    description: 'INSUFFICIENT_CAPACITY, RESERVATION_CONFLICT',
  })
  @ApiUnprocessableEntityResponse({
    type: ProblemModel,
    description: 'CURRENCY_NOT_SUPPORTED, FX_RATE_UNAVAILABLE, IDEMPOTENCY_KEY_REUSED',
  })
  @ApiServiceUnavailableResponse({
    type: ProblemModel,
    description: 'SERVICE_UNAVAILABLE (retry after Retry-After)',
  })
  async reserve(
    @Param() params: ProgramParamsDto,
    @Body() body: ReserveRequestDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @CorrelationId() correlationId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReservationView> {
    const result = await this.reserveCapacity.execute({
      program: { tenantId: principal.tenantId, programId: params.programId },
      invoiceId: body.invoiceId,
      amount: Money.parse(body.amount.amountMinor, body.amount.currency),
      idempotencyKey: parseIdempotencyKey(idempotencyKey, false),
      correlationId,
    });
    if (result.status === 201) {
      res.location(
        `/v1/programs/${encodeURIComponent(params.programId)}/reservations/${result.body.id}`,
      );
    }
    return respond(res, result);
  }

  /** `GET /programs/:programId/reservations` — list reservations (`capacity:read`). */
  @Get()
  @RequireScopes(Scope.READ)
  @ApiOperation({ summary: 'List reservations, newest first (keyset pagination)' })
  @ApiOkResponse({ type: ReservationPageModel })
  list(
    @Param() params: ProgramParamsDto,
    @Query() query: ListReservationsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Page<ReservationView>> {
    return this.readModel.listReservations(
      { tenantId: principal.tenantId, programId: params.programId },
      { status: query.status, limit: query.limit, cursor: query.cursor },
    );
  }

  /** `GET …/reservations/:reservationId` — one reservation (`capacity:read`). */
  @Get(':reservationId')
  @RequireScopes(Scope.READ)
  @ApiOperation({ summary: 'Get one reservation including its FX lock' })
  @ApiOkResponse({ type: ReservationModel })
  get(
    @Param() params: ReservationParamsDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ReservationView> {
    return this.readModel.getReservation(
      { tenantId: principal.tenantId, programId: params.programId },
      params.reservationId,
    );
  }

  /**
   * `POST …/reservations/:reservationId/releases` — release capacity (`capacity:write`).
   * Requires an `Idempotency-Key` header.
   */
  @Post(':reservationId/releases')
  @HttpCode(200)
  @RequireScopes(Scope.WRITE)
  @ApiOperation({
    summary: 'Release capacity (full or partial repayment)',
    description:
      'Amount is in the invoice currency; omit it to release the remainder. Capacity freed is the ' +
      'cumulative pro-rata share of the locked program amount, rounded down; the final release frees ' +
      'exactly what remains (ADR-004).',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOkResponse({ type: ReleaseModel })
  @ApiConflictResponse({
    type: ProblemModel,
    description: 'RESERVATION_ALREADY_RELEASED, RESERVATION_MANAGED_EXTERNALLY',
  })
  @ApiUnprocessableEntityResponse({
    type: ProblemModel,
    description: 'OVER_RELEASE, CURRENCY_MISMATCH, IDEMPOTENCY_KEY_REUSED',
  })
  @ApiServiceUnavailableResponse({
    type: ProblemModel,
    description: 'SERVICE_UNAVAILABLE (retry after Retry-After)',
  })
  async release(
    @Param() params: ReservationParamsDto,
    @Body() body: ReleaseRequestDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @CorrelationId() correlationId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReleaseView> {
    const result = await this.releaseReservation.execute({
      program: { tenantId: principal.tenantId, programId: params.programId },
      reservationId: params.reservationId,
      amount: body.amount ? Money.parse(body.amount.amountMinor, body.amount.currency) : undefined,
      idempotencyKey: parseIdempotencyKey(idempotencyKey, true),
      correlationId,
    });
    return respond(res, result);
  }
}

function respond<T>(res: Response, result: IdempotentResult<T>): T {
  res.status(result.status);
  if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
  return result.body;
}
