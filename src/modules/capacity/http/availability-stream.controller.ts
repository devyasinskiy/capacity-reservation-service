import { Controller, Inject, type MessageEvent, Param, Sse } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import {
  auditTime,
  catchError,
  concatMap,
  distinctUntilChanged,
  EMPTY,
  filter,
  from,
  interval,
  map,
  merge,
  type Observable,
  of,
} from 'rxjs';
import { CurrentPrincipal, RequireScopes } from '../../auth/decorators';
import type { Principal } from '../../auth/principal';
import { Scope } from '../../auth/scopes';
import {
  CAPACITY_READ_MODEL,
  type CapacityReadModel,
} from '../application/ports/capacity-read-model';
import type { AvailabilityView } from '../application/views';
import { PgAvailabilityChanges } from '../infrastructure/notifications/pg-availability-changes';
import { ProgramParamsDto } from './dto';
import { AvailabilityModel } from './openapi.models';

const HEARTBEAT_MS = 15_000;
const COALESCE_MS = 100;

/** Server-Sent Events stream of a program's availability (ADR-014). */
@ApiTags('programs')
@ApiBearerAuth()
@Controller('programs/:programId/availability')
export class AvailabilityStreamController {
  constructor(
    @Inject(CAPACITY_READ_MODEL) private readonly readModel: CapacityReadModel,
    private readonly changes: PgAvailabilityChanges,
  ) {}

  /**
   * Server-Sent Events (ADR-014). `@Sse` is Nest's built-in SSE support: the handler returns an
   * Observable and Nest writes each emission as an event. The handler is async so a missing
   * program fails with a normal 404 *before* the stream opens.
   */
  @Sse('stream')
  @RequireScopes(Scope.READ)
  @ApiOperation({
    summary: 'Live availability (Server-Sent Events)',
    description:
      'Emits `availability` with the current state on connect and after every committed change ' +
      '(bursts coalesced to ≤ 10/s), plus `heartbeat` every 15s. `id` = program version; a jump means ' +
      'intermediate states were coalesced, never that state was missed — each event is a full consistent read.',
  })
  @ApiProduces('text/event-stream')
  @ApiOkResponse({
    type: AvailabilityModel,
    description: 'data payload of each `availability` event',
  })
  async stream(
    @Param() params: ProgramParamsDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<Observable<MessageEvent>> {
    const key = { tenantId: principal.tenantId, programId: params.programId };
    const initial = await this.readModel.getAvailability(key);

    const updates = this.changes.changes$.pipe(
      filter(
        (c) =>
          c.programId === '*' || (c.tenantId === key.tenantId && c.programId === key.programId),
      ),
      auditTime(COALESCE_MS),
      // Re-read rather than trust the notification payload: every event is a consistent snapshot.
      concatMap(() => from(this.readModel.getAvailability(key)).pipe(catchError(() => EMPTY))),
    );

    const availability = merge(of(initial), updates).pipe(
      distinctUntilChanged((a, b) => a.version === b.version),
      map((view: AvailabilityView): MessageEvent => ({
        type: 'availability',
        id: view.version,
        data: view,
      })),
    );
    const heartbeat = interval(HEARTBEAT_MS).pipe(
      map((): MessageEvent => ({ type: 'heartbeat', data: '' })),
    );

    // Never let an internal error message reach the client (Nest would write err.message as an event).
    return merge(availability, heartbeat).pipe(catchError(() => EMPTY));
  }
}
