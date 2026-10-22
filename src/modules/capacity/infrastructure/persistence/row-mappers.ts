import type { Selectable } from 'kysely';
import type { ProgramsTable, ReservationsTable } from '../../../../shared/database/database.types';
import { Money } from '../../../../shared/money/money';
import { Program } from '../../domain/program';
import { Reservation } from '../../domain/reservation';

/** Maps a `programs` row to the domain aggregate. */
export function toProgram(row: Selectable<ProgramsTable>): Program {
  return Program.restore({
    tenantId: row.tenant_id,
    programId: row.program_id,
    limit: Money.of(row.limit_minor, row.currency),
    reserved: Money.of(row.reserved_minor, row.currency),
    limitVersion: row.limit_version,
    snapshotVersion: row.snapshot_version,
  });
}

/** Maps a `reservations` row to the domain entity, restoring the quoted FX rate form. */
export function toReservation(row: Selectable<ReservationsTable>): Reservation {
  return Reservation.restore({
    id: row.id,
    tenantId: row.tenant_id,
    programId: row.program_id,
    invoiceId: row.invoice_id,
    origin: row.origin,
    externalRef: row.external_ref,
    status: row.status,
    invoiceAmount: Money.of(row.invoice_amount_minor, row.invoice_currency),
    releasedInvoice: Money.of(row.released_invoice_minor, row.invoice_currency),
    programAmount: Money.of(row.program_amount_minor, row.program_currency),
    releasedProgram: Money.of(row.released_program_minor, row.program_currency),
    fx: { rate: normaliseDecimal(row.fx_rate), source: row.fx_source, asOf: row.fx_as_of },
    createdAt: row.created_at,
  });
}

/** numeric(30,12) comes back zero-padded ("1.082500000000"); restore the quoted form. */
function normaliseDecimal(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}
