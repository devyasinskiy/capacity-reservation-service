import { resolveCorrelationId } from './correlation-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('resolveCorrelationId', () => {
  it('keeps a well-formed caller ID', () => {
    expect(resolveCorrelationId('req-123:abc')).toBe('req-123:abc');
    expect(resolveCorrelationId(['first', 'second'])).toBe('first');
  });

  it.each([undefined, '', 'has space', 'x'.repeat(129), 'line\nbreak', 42])(
    'generates a UUID for unusable input %p',
    (input) => {
      expect(resolveCorrelationId(input)).toMatch(UUID);
    },
  );
});
