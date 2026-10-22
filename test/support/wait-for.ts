/** Polls until `probe` returns a truthy value or the timeout elapses. */
export async function waitFor<T>(
  probe: () => Promise<T | undefined | null | false>,
  timeoutMs = 30_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `waitFor timed out after ${timeoutMs}ms${last instanceof Error ? `: ${last.message}` : ''}`,
  );
}
