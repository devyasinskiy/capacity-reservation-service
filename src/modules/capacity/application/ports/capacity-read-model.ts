import type { ReservationStatus } from '../../domain/reservation';
import type { ProgramKey } from './capacity-store';
import type {
  AvailabilityView,
  DiscrepancyView,
  LedgerEntryView,
  Page,
  ReservationView,
} from '../views';

/**
 * Query side (CQRS-lite): plain views straight from SQL, no aggregate loading, no locks.
 * READ COMMITTED single statements, so every view is a consistent committed state.
 * Methods throw PROGRAM_NOT_FOUND when the program does not exist for the tenant.
 */
export interface CapacityReadModel {
  /** Current limit, reserved, available and version for one program. */
  getAvailability(key: ProgramKey): Promise<AvailabilityView>;
  /** One reservation of the program. @throws DomainError `RESERVATION_NOT_FOUND`. */
  getReservation(key: ProgramKey, reservationId: string): Promise<ReservationView>;
  /** Reservations of the program, newest first, optionally filtered by status; cursor-paginated. */
  listReservations(
    key: ProgramKey,
    query: { status?: ReservationStatus; limit: number; cursor?: string },
  ): Promise<Page<ReservationView>>;
  /** Ledger movements of the program, newest first; cursor-paginated. */
  getLedger(
    key: ProgramKey,
    query: { limit: number; cursor?: string },
  ): Promise<Page<LedgerEntryView>>;
  /** Reconciliation discrepancies, optionally filtered by status; cursor-paginated. */
  listDiscrepancies(
    key: ProgramKey,
    query: { status?: DiscrepancyView['status']; limit: number; cursor?: string },
  ): Promise<Page<DiscrepancyView>>;
}

/** DI token for {@link CapacityReadModel}. */
export const CAPACITY_READ_MODEL = Symbol('CapacityReadModel');
