import { type ArgumentsHost, BadRequestException } from '@nestjs/common';
import { DomainError } from './domain-error';
import { ProblemDetailsFilter } from './problem-details.filter';
import { RetryableError } from './retryable-error';

function run(exception: unknown) {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader: (k: string, v: string) => (headers[k] = v),
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    type() {
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({ getRequest: () => ({ id: 'corr-1' }), getResponse: () => res }),
  } as unknown as ArgumentsHost;
  new ProblemDetailsFilter().catch(exception, host);
  return { status: res.statusCode, body: res.body as Record<string, unknown>, headers };
}

describe('ProblemDetailsFilter', () => {
  it('maps domain errors to their status, code and client-safe details', () => {
    const out = run(
      new DomainError('INSUFFICIENT_CAPACITY', 'Not enough', { availableMinor: '5' }),
    );
    expect(out.status).toBe(409);
    expect(out.body).toMatchObject({
      code: 'INSUFFICIENT_CAPACITY',
      title: 'Conflict',
      detail: 'Not enough',
      details: { availableMinor: '5' },
      correlationId: 'corr-1',
      type: 'urn:problem-type:capacity:insufficient-capacity',
    });
  });

  it('maps retryable infrastructure errors to 503 + Retry-After without internals', () => {
    const out = run(new RetryableError('lock wait on programs row (tenant t-1)', 'LOCK_TIMEOUT'));
    expect(out.status).toBe(503);
    expect(out.headers['Retry-After']).toBe('1');
    expect(out.body.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(out.body)).not.toMatch(/lock wait|programs row|t-1/);
  });

  it('hides unexpected errors behind a generic 500', () => {
    const out = run(new Error('relation "secret_table" does not exist'));
    expect(out.status).toBe(500);
    expect(out.body).toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: 'An unexpected error occurred.',
    });
    expect(JSON.stringify(out.body)).not.toContain('secret_table');
  });

  it('never echoes framework messages for 4xx', () => {
    const out = run(
      new BadRequestException('Unexpected token } in JSON at position 12: {"pan":"4111"}'),
    );
    expect(out.body.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(out.body)).not.toContain('4111');
  });
});
