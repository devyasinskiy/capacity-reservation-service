import { RetryableError } from '../../../../shared/errors/retryable-error';
import { translateDbError } from './pg-errors';

const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

describe('translateDbError', () => {
  it.each([
    ['55P03', 'LOCK_TIMEOUT'],
    ['57014', 'STATEMENT_TIMEOUT'],
    ['40001', 'SERIALIZATION'],
    ['40P01', 'SERIALIZATION'],
    ['57P01', 'CONNECTION'],
    ['ECONNREFUSED', 'CONNECTION'],
  ])('maps %s to RetryableError(%s)', (code, reason) => {
    const out = translateDbError(pgError(code));
    expect(out).toBeInstanceOf(RetryableError);
    expect((out as RetryableError).reason).toBe(reason);
  });

  it('maps pool acquire timeouts (no code) to a retryable CONNECTION error', () => {
    const out = translateDbError(new Error('timeout exceeded when trying to connect'));
    expect((out as RetryableError).reason).toBe('CONNECTION');
  });

  it.each([pgError('23505'), pgError('23514'), new Error('other'), 'string'])(
    'passes through %p',
    (e) => {
      expect(translateDbError(e)).toBe(e);
    },
  );
});
