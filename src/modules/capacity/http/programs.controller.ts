import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPrincipal, RequireScopes } from '../../auth/decorators';
import type { Principal } from '../../auth/principal';
import { Scope } from '../../auth/scopes';
import {
  CAPACITY_READ_MODEL,
  type CapacityReadModel,
} from '../application/ports/capacity-read-model';
import type {
  AvailabilityView,
  DiscrepancyView,
  LedgerEntryView,
  Page,
} from '../application/views';
import { ListDiscrepanciesQueryDto, PageQueryDto, ProgramParamsDto } from './dto';
import {
  AvailabilityModel,
  DiscrepancyPageModel,
  LedgerPageModel,
  ProblemModel,
} from './openapi.models';

/**
 * Program-level read endpoints: availability, ledger and reconciliation discrepancies.
 * Tenant comes from the token, so another tenant's program is indistinguishable from a missing one.
 */
@ApiTags('programs')
@ApiBearerAuth()
@ApiNotFoundResponse({
  type: ProblemModel,
  description: 'PROGRAM_NOT_FOUND (also for other tenants)',
})
@ApiForbiddenResponse({ type: ProblemModel, description: 'INSUFFICIENT_SCOPE' })
@Controller('programs/:programId')
export class ProgramsController {
  constructor(@Inject(CAPACITY_READ_MODEL) private readonly readModel: CapacityReadModel) {}

  /** `GET /programs/:programId/availability` — current capacity (`capacity:read`). */
  @Get('availability')
  @RequireScopes(Scope.READ)
  @ApiOperation({ summary: 'Current limit, reserved and available capacity (consistent read)' })
  @ApiOkResponse({ type: AvailabilityModel })
  availability(
    @Param() params: ProgramParamsDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AvailabilityView> {
    return this.readModel.getAvailability({
      tenantId: principal.tenantId,
      programId: params.programId,
    });
  }

  /** `GET /programs/:programId/ledger` — audit trail, newest first (`capacity:audit`). */
  @Get('ledger')
  @RequireScopes(Scope.AUDIT)
  @ApiOperation({ summary: 'Append-only movements explaining the balance, newest first (ADR-008)' })
  @ApiOkResponse({ type: LedgerPageModel })
  ledger(
    @Param() params: ProgramParamsDto,
    @Query() query: PageQueryDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Page<LedgerEntryView>> {
    return this.readModel.getLedger(
      { tenantId: principal.tenantId, programId: params.programId },
      { limit: query.limit, cursor: query.cursor },
    );
  }

  /** `GET /programs/:programId/discrepancies` — reconciliation findings (`capacity:audit`). */
  @Get('discrepancies')
  @RequireScopes(Scope.AUDIT)
  @ApiOperation({
    summary: 'Reconciliation discrepancies (read-only)',
    description:
      'Differences between treasury snapshots and our ledger as of the snapshot time. Never auto-corrected: ' +
      'PENDING after one snapshot, OPEN (flagged for review) when reproduced by the next, CLEARED when resolved (ADR-011).',
  })
  @ApiOkResponse({ type: DiscrepancyPageModel })
  discrepancies(
    @Param() params: ProgramParamsDto,
    @Query() query: ListDiscrepanciesQueryDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Page<DiscrepancyView>> {
    return this.readModel.listDiscrepancies(
      { tenantId: principal.tenantId, programId: params.programId },
      { status: query.status, limit: query.limit, cursor: query.cursor },
    );
  }
}
