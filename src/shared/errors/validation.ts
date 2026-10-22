import { BadRequestException, ValidationPipe, type ValidationError } from '@nestjs/common';
import { ErrorCode } from './error-codes';

/** One invalid request field (dotted path) and its validation messages. */
export interface FieldError {
  readonly field: string;
  readonly messages: string[];
}

/** Flattens nested class-validator errors into `amount.amountMinor`-style paths. */
export function flattenValidationErrors(errors: ValidationError[], parent = ''): FieldError[] {
  return errors.flatMap((e) => {
    const field = parent ? `${parent}.${e.property}` : e.property;
    const own = e.constraints ? [{ field, messages: Object.values(e.constraints) }] : [];
    return [...own, ...flattenValidationErrors(e.children ?? [], field)];
  });
}

/**
 * Global pipe (registered via APP_PIPE so it is DI-managed and active in tests): strips unknown
 * properties, rejects them outright, and turns DTO failures into VALIDATION_FAILED problems.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      new BadRequestException({
        code: ErrorCode.VALIDATION_FAILED,
        detail: 'The request is invalid.',
        errors: flattenValidationErrors(errors),
      }),
  });
}
