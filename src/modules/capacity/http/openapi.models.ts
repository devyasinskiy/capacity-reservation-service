import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Response shapes for OpenAPI only; runtime values are the application views. */

export class MoneyModel {
  @ApiProperty({ example: '1082500' }) amountMinor!: string;
  @ApiProperty({ example: 'USD' }) currency!: string;
}

/** OpenAPI shape of `AvailabilityView`. */
export class AvailabilityModel {
  @ApiProperty() programId!: string;
  @ApiProperty({ example: 'USD' }) currency!: string;
  @ApiProperty({ type: MoneyModel }) limit!: MoneyModel;
  @ApiProperty({ type: MoneyModel }) reserved!: MoneyModel;
  @ApiProperty({ type: MoneyModel, description: 'limit − reserved; may be negative (ADR-013)' })
  available!: MoneyModel;
  @ApiProperty() overLimit!: boolean;
  @ApiProperty({ example: '42', description: 'Monotonic per-program change counter' })
  version!: string;
  @ApiProperty({ format: 'date-time' }) asOf!: string;
}

/** OpenAPI shape of a reservation's locked FX rate. */
export class FxLockModel {
  @ApiProperty({
    example: '1.0825',
    description: 'Program-currency units per 1 invoice-currency unit',
  })
  rate!: string;
  @ApiProperty({ example: 'STUB' }) source!: string;
  @ApiProperty({ format: 'date-time' }) asOf!: string;
}

/** OpenAPI shape of `ReservationView`. */
export class ReservationModel {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() programId!: string;
  @ApiProperty() invoiceId!: string;
  @ApiProperty({ enum: ['LOCAL', 'EXTERNAL'] }) origin!: string;
  @ApiPropertyOptional({ nullable: true, type: String }) externalRef!: string | null;
  @ApiProperty({ enum: ['ACTIVE', 'PARTIALLY_RELEASED', 'RELEASED'] }) status!: string;
  @ApiProperty({ type: MoneyModel }) invoiceAmount!: MoneyModel;
  @ApiProperty({ type: MoneyModel }) releasedInvoiceAmount!: MoneyModel;
  @ApiProperty({ type: MoneyModel }) outstandingInvoiceAmount!: MoneyModel;
  @ApiProperty({ type: MoneyModel, description: 'Locked at reservation time (ADR-003)' })
  programAmount!: MoneyModel;
  @ApiProperty({ type: MoneyModel }) releasedProgramAmount!: MoneyModel;
  @ApiProperty({ type: MoneyModel }) outstandingProgramAmount!: MoneyModel;
  @ApiProperty({ type: FxLockModel }) fx!: FxLockModel;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

/** OpenAPI shape of what a single release freed. */
export class ReleaseDetailModel {
  @ApiProperty({ type: MoneyModel }) releasedInvoiceAmount!: MoneyModel;
  @ApiProperty({ type: MoneyModel, description: 'Cumulative pro-rata, rounded down (ADR-004)' })
  freedProgramAmount!: MoneyModel;
}

/** OpenAPI shape of `ReleaseView`. */
export class ReleaseModel {
  @ApiProperty({ type: ReservationModel }) reservation!: ReservationModel;
  @ApiProperty({ type: ReleaseDetailModel }) release!: ReleaseDetailModel;
}

/** OpenAPI shape of a page of reservations. */
export class ReservationPageModel {
  @ApiProperty({ type: [ReservationModel] }) items!: ReservationModel[];
  @ApiPropertyOptional({ nullable: true, type: String }) nextCursor!: string | null;
}

/** OpenAPI shape of `LedgerEntryView`. */
export class LedgerEntryModel {
  @ApiProperty() id!: string;
  @ApiProperty({
    enum: ['RESERVE', 'RELEASE', 'LIMIT_SET', 'EXTERNAL_RESERVE', 'EXTERNAL_RELEASE'],
  })
  type!: string;
  @ApiPropertyOptional({ nullable: true, type: String }) reservationId!: string | null;
  @ApiProperty({ type: MoneyModel }) reservedDelta!: MoneyModel;
  @ApiProperty({ type: MoneyModel }) limitAfter!: MoneyModel;
  @ApiProperty({ type: MoneyModel }) reservedAfter!: MoneyModel;
  @ApiProperty({ enum: ['HTTP', 'KAFKA', 'SYSTEM'] }) source!: string;
  @ApiPropertyOptional({ nullable: true, type: String }) sourceRef!: string | null;
  @ApiPropertyOptional({ nullable: true, type: String }) correlationId!: string | null;
  @ApiProperty({ format: 'date-time' }) occurredAt!: string;
}

/** OpenAPI shape of a page of ledger entries. */
export class LedgerPageModel {
  @ApiProperty({ type: [LedgerEntryModel] }) items!: LedgerEntryModel[];
  @ApiPropertyOptional({ nullable: true, type: String }) nextCursor!: string | null;
}

/** OpenAPI shape of the RFC 9457 error body. */
export class ProblemModel {
  @ApiProperty({ example: 'urn:problem-type:capacity:insufficient-capacity' }) type!: string;
  @ApiProperty({ example: 'Conflict' }) title!: string;
  @ApiProperty({ example: 409 }) status!: number;
  @ApiProperty({ example: 'INSUFFICIENT_CAPACITY' }) code!: string;
  @ApiProperty() detail!: string;
  @ApiPropertyOptional() correlationId?: string;
  @ApiPropertyOptional({ type: Object, description: 'Client-safe context, e.g. availableMinor' })
  details?: Record<string, string>;
  @ApiPropertyOptional({ type: [Object], description: 'Field errors for VALIDATION_FAILED' })
  errors?: unknown[];
}

/** OpenAPI shape of `DiscrepancyView`. */
export class DiscrepancyModel {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['MISSING_LOCALLY', 'MISSING_IN_TREASURY', 'AMOUNT_MISMATCH'] })
  kind!: string;
  @ApiProperty({ enum: ['LOCAL', 'EXTERNAL'] }) origin!: string;
  @ApiProperty({ description: 'LOCAL: reservation id; EXTERNAL: treasury externalRef' })
  reservationRef!: string;
  @ApiProperty() invoiceId!: string;
  @ApiPropertyOptional({ type: MoneyModel, nullable: true }) localOutstanding!: MoneyModel | null;
  @ApiPropertyOptional({ type: MoneyModel, nullable: true })
  treasuryOutstanding!: MoneyModel | null;
  @ApiProperty({ description: 'Consecutive snapshots reproducing it (ADR-011)' }) strikes!: number;
  @ApiProperty({ enum: ['PENDING', 'OPEN', 'CLEARED'] }) status!: string;
  @ApiProperty({ format: 'uuid' }) firstRunId!: string;
  @ApiProperty({ format: 'uuid' }) lastRunId!: string;
  @ApiProperty({ format: 'date-time' }) detectedAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

/** OpenAPI shape of a page of discrepancies. */
export class DiscrepancyPageModel {
  @ApiProperty({ type: [DiscrepancyModel] }) items!: DiscrepancyModel[];
  @ApiPropertyOptional({ nullable: true, type: String }) nextCursor!: string | null;
}
