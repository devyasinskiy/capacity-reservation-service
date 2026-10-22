import { DomainError } from '../../../shared/errors/domain-error';
import { RetryableError } from '../../../shared/errors/retryable-error';
import { backoffDelay, classifyFailure } from './retry-policy';
import { InvalidTreasuryMessageError } from './treasury-message.schema';

describe('classifyFailure', () => {
  it.each([
    [new InvalidTreasuryMessageError('bad'), false, 'INVALID_MESSAGE'],
    [new DomainError('OVER_RELEASE', 'x'), false, 'OVER_RELEASE'],
    [new RetryableError('x', 'LOCK_TIMEOUT'), true, 'TRANSIENT_LOCK_TIMEOUT'],
    [new Error('boom'), true, 'UNEXPECTED_ERROR'],
  ])('%p → retryable=%p (%s)', (error, retryable, code) => {
    expect(classifyFailure(error)).toEqual({ retryable, code });
  });
});

describe('backoffDelay', () => {
  const policy = { maxAttempts: 5, initialDelayMs: 200, maxDelayMs: 5000 };
  it('grows exponentially and is capped', () => {
    expect([1, 2, 3, 4, 5, 6, 10].map((a) => backoffDelay(policy, a, () => 1))).toEqual([
      200, 400, 800, 1600, 3200, 5000, 5000,
    ]);
  });
  it('applies full jitter', () => {
    expect(backoffDelay(policy, 3, () => 0)).toBe(0);
    expect(backoffDelay(policy, 3, () => 0.5)).toBe(400);
  });
});
