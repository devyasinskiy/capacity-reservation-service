import type {
  CapacityStore,
  ProgramKey,
} from '../../src/modules/capacity/application/ports/capacity-store';

/** A promise plus its resolver, for hand-off between concurrent test actors. */
export function signal(): { promise: Promise<void>; fire: () => void } {
  let fire!: () => void;
  const promise = new Promise<void>((resolve) => (fire = resolve));
  return { promise, fire };
}

/**
 * Holds a program's row lock until `release()` is called. `acquired` resolves only once the lock
 * is really held — tests must await it instead of sleeping, or they race the pool/lock under load.
 */
export function holdProgramLock(store: CapacityStore, key: ProgramKey) {
  const acquired = signal();
  const released = signal();
  const done = store.withLockedProgram(key, { source: 'SYSTEM' }, async () => {
    acquired.fire();
    await released.promise;
  });
  return { acquired: acquired.promise, release: released.fire, done };
}
