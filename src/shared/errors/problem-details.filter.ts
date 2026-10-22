import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError, type DomainErrorCode } from './domain-error';
import { ErrorCode } from './error-codes';
import { RetryableError } from './retryable-error';

/** RFC 9457 problem body plus the service's stable `code` and the request's correlation ID. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  correlationId?: string;
  details?: Readonly<Record<string, string>>;
  errors?: unknown[];
}

/** HTTP status per domain error — the only place the domain meets HTTP (ADR-015). */
export const DOMAIN_ERROR_STATUS: Record<DomainErrorCode, number> = {
  INVALID_AMOUNT: 400,
  AMOUNT_OUT_OF_RANGE: 400,
  INVALID_CURSOR: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  PROGRAM_NOT_FOUND: 404,
  RESERVATION_NOT_FOUND: 404,
  INSUFFICIENT_CAPACITY: 409,
  RESERVATION_CONFLICT: 409,
  RESERVATION_ALREADY_RELEASED: 409,
  RESERVATION_MANAGED_EXTERNALLY: 409,
  CURRENCY_NOT_SUPPORTED: 422,
  CURRENCY_MISMATCH: 422,
  FX_RATE_UNAVAILABLE: 422,
  OVER_RELEASE: 422,
  IDEMPOTENCY_KEY_REUSED: 422,
  // Kafka-only today (dead-lettered), mapped for completeness.
  SNAPSHOT_INCONSISTENT: 422,
};

const RETRY_AFTER_SECONDS = '1';

const DEFAULT_CODE_BY_STATUS: Record<number, ErrorCode> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.VALIDATION_FAILED,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHENTICATED,
  [HttpStatus.FORBIDDEN]: ErrorCode.INSUFFICIENT_SCOPE,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.METHOD_NOT_ALLOWED]: ErrorCode.METHOD_NOT_ALLOWED,
  [HttpStatus.PAYLOAD_TOO_LARGE]: ErrorCode.PAYLOAD_TOO_LARGE,
  [HttpStatus.SERVICE_UNAVAILABLE]: ErrorCode.SERVICE_UNAVAILABLE,
};

const DEFAULT_DETAIL: Partial<Record<ErrorCode, string>> = {
  [ErrorCode.VALIDATION_FAILED]: 'The request is invalid.',
  [ErrorCode.UNAUTHENTICATED]: 'A valid bearer token is required.',
  [ErrorCode.INSUFFICIENT_SCOPE]: 'The token does not grant the scope required for this operation.',
  [ErrorCode.NOT_FOUND]: 'The requested resource does not exist.',
  [ErrorCode.SERVICE_UNAVAILABLE]: 'The service is temporarily unavailable; retry shortly.',
  [ErrorCode.INTERNAL_ERROR]: 'An unexpected error occurred.',
};

/**
 * Translates every exception into RFC 9457 problem+json with a stable `code` (ADR-015).
 * Registered via APP_FILTER (Nest's DI-aware way to install a global filter, so it also applies
 * in test modules). 5xx responses never carry internal details; those go to the logs only.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  /** Writes `exception` as an `application/problem+json` response. */
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request & { id?: string }>();
    const res = ctx.getResponse<Response>();

    const problem = this.toProblem(exception);
    problem.correlationId = typeof req.id === 'string' ? req.id : undefined;

    if (exception instanceof RetryableError) {
      this.logger.warn({ reason: exception.reason, err: exception.cause }, exception.message);
      res.setHeader('Retry-After', RETRY_AFTER_SECONDS);
    } else if (problem.status >= 500) {
      this.logger.error({ err: exception, code: problem.code }, 'Unhandled error');
    }
    if (problem.status === 401) {
      // RFC 6750 §3: tell the client which auth scheme is expected.
      res.setHeader('WWW-Authenticate', 'Bearer realm="program-capacity"');
    }
    res.status(problem.status).type('application/problem+json').json(problem);
  }

  private toProblem(exception: unknown): ProblemDetails {
    if (exception instanceof DomainError) {
      const problem = build(DOMAIN_ERROR_STATUS[exception.code], exception.code, exception.message);
      if (exception.details) problem.details = exception.details;
      return problem;
    }
    if (exception instanceof RetryableError) {
      return build(503, ErrorCode.SERVICE_UNAVAILABLE, DEFAULT_DETAIL.SERVICE_UNAVAILABLE!);
    }
    if (!(exception instanceof HttpException) || exception.getStatus() >= 500) {
      const status = exception instanceof HttpException ? exception.getStatus() : 500;
      const code = status === 503 ? ErrorCode.SERVICE_UNAVAILABLE : ErrorCode.INTERNAL_ERROR;
      return build(status, code, DEFAULT_DETAIL[code]!);
    }

    const status = exception.getStatus();
    const body = exception.getResponse();
    const explicit =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const code =
      typeof explicit.code === 'string'
        ? explicit.code
        : (DEFAULT_CODE_BY_STATUS[status] ?? `HTTP_${status}`);
    // Never echo framework/parser messages (e.g. JSON parse errors quote the payload).
    const detail =
      typeof explicit.detail === 'string'
        ? explicit.detail
        : (DEFAULT_DETAIL[code as ErrorCode] ?? 'The request could not be processed.');
    const problem = build(status, code, detail);
    if (Array.isArray(explicit.errors)) problem.errors = explicit.errors;
    return problem;
  }
}

function build(status: number, code: string, detail: string): ProblemDetails {
  return {
    type: `urn:problem-type:capacity:${code.toLowerCase().replace(/_/g, '-')}`,
    title: titleFor(status),
    status,
    code,
    detail,
  };
}

function titleFor(status: number): string {
  const name = HttpStatus[status];
  if (typeof name !== 'string') return 'Error';
  return name
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
