import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { ReservationStatus } from '../domain/reservation';

// class-validator DTOs validate shape at the HTTP boundary; business rules (positive amount,
// supported currency, capacity) stay in the domain so Kafka input gets the same checks.

/** Money on the wire: integer minor units as a string plus an ISO 4217 code. */
export class MoneyDto {
  @ApiProperty({
    example: '1250000',
    description: 'Integer amount in minor units, as a string (ADR-002)',
  })
  @IsString()
  @Matches(/^\d{1,19}$/, {
    message: 'amountMinor must be a non-negative integer string of minor units',
  })
  amountMinor!: string;

  @ApiProperty({ example: 'EUR', description: 'ISO 4217 code' })
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO 4217 code' })
  currency!: string;
}

/** Body of `POST /programs/:programId/reservations`. */
export class ReserveRequestDto {
  @ApiProperty({ example: 'INV-2026-000123' })
  @IsString()
  @Matches(/^[A-Za-z0-9._:/-]{1,128}$/, { message: 'invoiceId must be 1-128 safe characters' })
  invoiceId!: string;

  @ApiProperty({ type: MoneyDto, description: 'Invoice amount in the invoice currency' })
  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyDto)
  amount!: MoneyDto;
}

/** Body of `POST …/reservations/:reservationId/releases`. */
export class ReleaseRequestDto {
  @ApiPropertyOptional({
    type: MoneyDto,
    description:
      'Amount repaid, in the invoice currency. Omit to release the outstanding remainder.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => MoneyDto)
  amount?: MoneyDto;
}

/** Route params for program-scoped endpoints. */
export class ProgramParamsDto {
  @ApiProperty({ example: 'PRG-USD-001' })
  @Matches(/^[A-Za-z0-9_-]{1,64}$/, { message: 'programId must be 1-64 of [A-Za-z0-9_-]' })
  programId!: string;
}

/** Route params for reservation-scoped endpoints. */
export class ReservationParamsDto extends ProgramParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  reservationId!: string;
}

/** Keyset pagination query: page size and opaque cursor. */
export class PageQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;

  @ApiPropertyOptional({ description: 'Opaque cursor from a previous page' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}

/** Query for listing reservations, optionally filtered by status. */
export class ListReservationsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['ACTIVE', 'PARTIALLY_RELEASED', 'RELEASED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'PARTIALLY_RELEASED', 'RELEASED'])
  status?: ReservationStatus;
}

/** Query for listing reconciliation discrepancies, optionally filtered by status. */
export class ListDiscrepanciesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: ['PENDING', 'OPEN', 'CLEARED'],
    description: 'OPEN = flagged for review',
  })
  @IsOptional()
  @IsIn(['PENDING', 'OPEN', 'CLEARED'])
  status?: 'PENDING' | 'OPEN' | 'CLEARED';
}
