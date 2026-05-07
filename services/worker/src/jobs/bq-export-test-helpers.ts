/**
 * Shared test helpers for the bq-export-* integration tests (SCRUM-1723 /
 * 1724 / 1727). Extracting these here makes the integration test files
 * smaller, easier to read, and avoids triggering SonarCloud's duplicate-
 * code detector across the three near-identical mock-setup blocks.
 *
 * NOT intended to be imported from non-test code (no source file imports
 * this; the worker bundle won't include it).
 */

/**
 * Build a Supabase-like chainable query mock that resolves to `result`
 * when awaited. Each chain method (`gt`, `order`, `limit`, etc.) returns
 * a Proxy that's also thenable, so the chain can have arbitrary depth
 * without explicit method allowlisting.
 *
 * Internally backed by a real Promise (not a custom-`then` object) so
 * SonarCloud / typescript-eslint don't flag it as a "do not add then to
 * an object" bug.
 */
export function chainSelect(result: { data: unknown; error: unknown }) {
  const promise = Promise.resolve(result);
  // Return a Proxy that returns itself for any method call (so the chain
  // works for arbitrary depth) but `then`/`catch`/`finally` come from the
  // backing Promise (so `await` works).
  const handler: ProxyHandler<typeof promise> = {
    get(target, prop, receiver) {
      if (prop === 'then' || prop === 'catch' || prop === 'finally') {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      // Any chain method (gt/order/limit/eq/etc.) returns the same proxy
      // so the chain can extend without method-allowlist drift.
      return () => proxy;
    },
  };
  const proxy = new Proxy(promise, handler);
  return proxy as unknown as Record<string, () => unknown> & PromiseLike<typeof result>;
}
