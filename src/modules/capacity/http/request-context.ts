import { BadRequestException, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { DomainError } from '../../../shared/errors/domain-error';
import { ErrorCode } from '../../../shared/errors/error-codes';

/** Correlation ID assigned by the logging middleware (pino-http genReqId); ADR-018. */
export const CorrelationId = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string | undefined => {
    const id = ctx.switchToHttp().getRequest<Request & { id?: unknown }>().id;
    return typeof id === 'string' ? id : undefined;
  },
);

const KEY = /^[A-Za-z0-9._:-]{1,255}$/;

/**
 * Validates the `Idempotency-Key` header.
 * @throws DomainError `IDEMPOTENCY_KEY_REQUIRED` if missing.
 * @throws BadRequestException if it is not 1–255 characters of `[A-Za-z0-9._:-]`.
 */
export function parseIdempotencyKey(value: string | undefined, required: true): string;
/**
 * Validates the optional `Idempotency-Key` header; `undefined` if absent.
 * @throws BadRequestException if it is not 1–255 characters of `[A-Za-z0-9._:-]`.
 */
export function parseIdempotencyKey(value: string | undefined, required: false): string | undefined;
export function parseIdempotencyKey(
  value: string | undefined,
  required: boolean,
): string | undefined {
  if (value === undefined || value === '') {
    if (required) {
      throw new DomainError(
        'IDEMPOTENCY_KEY_REQUIRED',
        'The Idempotency-Key header is required for this operation',
      );
    }
    return undefined;
  }
  if (!KEY.test(value)) {
    throw new BadRequestException({
      code: ErrorCode.VALIDATION_FAILED,
      detail: 'Idempotency-Key must be 1-255 characters of [A-Za-z0-9._:-]',
    });
  }
  return value;
}
