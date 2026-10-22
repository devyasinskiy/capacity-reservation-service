import { currentCorrelationId, runWithCorrelationId } from './correlation-context';

describe('correlation context', () => {
  it('is visible across awaits and timers inside the run, and absent outside', async () => {
    expect(currentCorrelationId()).toBeUndefined();
    await runWithCorrelationId('c-1', async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(currentCorrelationId()).toBe('c-1');
      await Promise.all([
        runWithCorrelationId('c-2', async () => {
          await Promise.resolve();
          expect(currentCorrelationId()).toBe('c-2');
        }),
        Promise.resolve().then(() => expect(currentCorrelationId()).toBe('c-1')),
      ]);
    });
    expect(currentCorrelationId()).toBeUndefined();
  });
});
