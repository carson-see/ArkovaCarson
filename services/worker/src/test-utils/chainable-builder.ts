/**
 * Chainable supabase-js builder stub for handler tests.
 *
 * Every builder method returns the builder; `await`-ing it yields the next
 * queued result (the last one repeats). Use `routeDbTables()` to hand a
 * different stub to each `db.from(<table>)` call.
 *
 * Sibling of `lazy-supabase-builder.ts` (which records deferred `.then()`
 * calls for fire-and-forget assertions); this one is for handlers that await
 * several chained queries against several tables in one request.
 */
import { vi, type Mock } from 'vitest';

export type DbResult = { data?: unknown; error?: unknown };

export type ChainableBuilder = Record<string, Mock> & {
  then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => Promise<unknown>;
};

const CHAIN_METHODS = [
  'select', 'eq', 'neq', 'is', 'in', 'contains', 'insert', 'limit', 'order', 'maybeSingle', 'single', 'filter', 'or',
] as const;

export function createChainableBuilder(
  results: DbResult | DbResult[],
  opts: { updateResult?: DbResult; deleteResult?: DbResult } = {},
): ChainableBuilder {
  const queue = Array.isArray(results) ? [...results] : [results];
  const b: Record<string, unknown> = {};
  const self = () => b;
  for (const m of CHAIN_METHODS) b[m] = vi.fn(self);
  b.update = vi.fn(() => (opts.updateResult ? createChainableBuilder(opts.updateResult) : b));
  b.delete = vi.fn(() => (opts.deleteResult ? createChainableBuilder(opts.deleteResult) : b));
  // typescript:S7739 — "Do not add `then` to an object". Suppressed on purpose:
  // supabase-js builders ARE lazy thenables, and the stub must be awaitable at
  // any point in the chain to mirror them. // NOSONAR
  b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
    const r = queue.length > 1 ? (queue.shift() as DbResult) : queue[0];
    return Promise.resolve({ data: r?.data ?? null, error: r?.error ?? null }).then(onF, onR);
  };
  return b as ChainableBuilder;
}

export function routeDbTables(dbFromMock: Mock, map: Record<string, unknown>): void {
  dbFromMock.mockImplementation((table: string) => {
    const t = map[table];
    if (!t) throw new Error(`unexpected table: ${table}`);
    return t;
  });
}
