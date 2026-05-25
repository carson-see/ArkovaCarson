/**
 * Shared test helpers for `services/worker/src/jobs/__tests__/*.test.ts`.
 *
 * Eliminates repeated `createMockSupabase()` + `as unknown as SupabaseClient`
 * boilerplate across 18 test files. Each file previously defined its own mock
 * with slightly different chain depths; this helper covers all observed
 * patterns via a configurable `chain` option.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { vi } from 'vitest';

/**
 * Chain method names supported by the mock builder. Each method either
 * continues the chain (returns `this`) or terminates it (resolves a promise).
 */
type ChainMethod =
  | 'eq' | 'in' | 'is' | 'not' | 'lt' | 'gte' | 'or'
  | 'order' | 'limit' | 'range' | 'single' | 'maybeSingle' | 'select';

interface MockSelectChain {
  chain: Record<string, ReturnType<typeof vi.fn>>;
  /** Direct reference to the terminal `.limit()` mock for per-test overrides. */
  limit: ReturnType<typeof vi.fn>;
  /** Direct reference to `.order()` for per-test overrides. */
  order: ReturnType<typeof vi.fn>;
  /** Direct reference to `.single()` for per-test overrides. */
  single: ReturnType<typeof vi.fn>;
  /** Direct reference to `.range()` for per-test overrides. */
  range: ReturnType<typeof vi.fn>;
}

export interface CreateMockSupabaseOptions {
  /**
   * Terminal resolution for `.limit()` and `.order()` (list queries).
   * Defaults to `{ data: [], error: null }`.
   */
  selectResult?: { data: unknown; error: unknown };

  /**
   * Terminal resolution for `.single()`.
   * Defaults to `{ data: null, error: null }`.
   */
  singleResult?: { data: unknown; error: unknown };

  /**
   * Terminal resolution for `.range()`.
   * Defaults to `{ data: [], error: null }`.
   */
  rangeResult?: { data: unknown; error: unknown };

  /**
   * Terminal resolution for `.in()` when used as a terminal (e.g. getExistingSourceIds).
   * Defaults to `{ data: [] }`.
   */
  inResult?: { data: unknown };

  /**
   * Override `.from()` mock — useful when the test needs per-table routing.
   * When provided, `selectChainMethods` is ignored.
   */
  fromImpl?: ReturnType<typeof vi.fn>;

  /**
   * Additional chainable methods to include on the select chain beyond the
   * defaults (`eq`, `in`, `is`, `not`, `lt`, `gte`, `or`, `order`, `limit`,
   * `range`, `single`, `select`). Each continues the chain (returns `this`).
   */
  extraChainMethods?: string[];

  /**
   * Override for `.upsert()`. Defaults to resolving `{ error: null }`.
   */
  upsertMock?: ReturnType<typeof vi.fn>;

  /**
   * Override for `.insert()`. Defaults to resolving `{ error: null }`.
   */
  insertMock?: ReturnType<typeof vi.fn>;

  /**
   * Override for `.update()`. When provided, `.update()` returns this value
   * directly (caller supplies further chaining). When omitted, `.update()`
   * is not included in the `from()` return.
   */
  updateMock?: ReturnType<typeof vi.fn>;

  /**
   * Override for `.rpc()`. Defaults to a fresh `vi.fn()`.
   */
  rpcMock?: ReturnType<typeof vi.fn>;
}

export interface MockSupabaseResult {
  /** The mock typed as `SupabaseClient` — pass directly to functions under test. */
  client: SupabaseClient;
  /** The `.rpc()` mock for per-test configuration. */
  rpc: ReturnType<typeof vi.fn>;
  /** The `.from()` mock for per-test configuration. */
  from: ReturnType<typeof vi.fn>;
  /** The select chain and its terminal mocks for per-test overrides. */
  selectChain: MockSelectChain;
  /** The `.upsert()` mock. */
  upsert: ReturnType<typeof vi.fn>;
  /** The `.insert()` mock. */
  insert: ReturnType<typeof vi.fn>;
  /** The `.update()` mock (may be undefined if not configured). */
  update: ReturnType<typeof vi.fn> | undefined;
}

/**
 * Build a fluent select chain. Every non-terminal method returns `this`;
 * terminal methods (`.limit()`, `.order()`, `.range()`) resolve a promise.
 */
export function buildSelectChain(opts: {
  selectResult?: { data: unknown; error: unknown };
  singleResult?: { data: unknown; error: unknown };
  rangeResult?: { data: unknown; error: unknown };
  inResult?: { data: unknown };
  extraChainMethods?: string[];
} = {}): MockSelectChain {
  const selectResult = opts.selectResult ?? { data: [], error: null };
  const singleResult = opts.singleResult ?? { data: null, error: null };
  const rangeResult = opts.rangeResult ?? { data: [], error: null };
  const inResult = opts.inResult ?? { data: [] };

  const chain: Record<string, ReturnType<typeof vi.fn>> = {};

  const self = () => chain;

  // Chainable methods that return `this`
  const chainable: ChainMethod[] = ['eq', 'is', 'not', 'lt', 'gte', 'or', 'select'];
  for (const method of chainable) {
    chain[method] = vi.fn(self);
  }
  if (opts.extraChainMethods) {
    for (const method of opts.extraChainMethods) {
      chain[method] = vi.fn(self);
    }
  }

  // `.in()` — sometimes terminal (resolves), sometimes chainable. We make it
  // resolve AND return the chain so both patterns work.
  chain.in = vi.fn(() => Object.assign(Promise.resolve(inResult), chain));

  // Terminal `.limit()` — resolves the list payload but remains chainable
  const mockLimit = vi.fn(() => Object.assign(Promise.resolve(selectResult), chain));
  chain.limit = mockLimit;

  // Terminal `.order()` — resolves list payload, also chainable to `.limit()`
  const mockOrder = vi.fn(() => Object.assign(Promise.resolve(selectResult), chain));
  chain.order = mockOrder;

  // Terminal `.range()` — resolves range payload
  const mockRange = vi.fn(() => Object.assign(Promise.resolve(rangeResult), chain));
  chain.range = mockRange;

  // Terminal `.single()` — resolves single-row payload
  const mockSingle = vi.fn(() => Promise.resolve(singleResult));
  chain.single = mockSingle;

  // Terminal `.maybeSingle()`
  chain.maybeSingle = vi.fn(() => Promise.resolve(singleResult));

  return { chain, limit: mockLimit, order: mockOrder, single: mockSingle, range: mockRange };
}

/**
 * Create a mock Supabase client that covers all chain patterns used across
 * the jobs test suite. Returns both the typed `SupabaseClient` and handles
 * to individual mocks for per-test assertions/overrides.
 *
 * @example
 * ```ts
 * import { createMockSupabase } from './__testHelpers.js';
 *
 * const { client, rpc, upsert, selectChain } = createMockSupabase();
 * rpc.mockResolvedValue({ data: true });
 * selectChain.limit.mockResolvedValue({ data: records, error: null });
 * const result = await fetchSomething(client);
 * expect(upsert).toHaveBeenCalledWith(expect.arrayContaining([...]));
 * ```
 */
export function createMockSupabase(opts: CreateMockSupabaseOptions = {}): MockSupabaseResult {
  const rpc = opts.rpcMock ?? vi.fn();
  const upsert = opts.upsertMock ?? vi.fn().mockResolvedValue({ error: null });
  const insert = opts.insertMock ?? vi.fn().mockResolvedValue({ error: null });
  const update = opts.updateMock;

  const sc = buildSelectChain({
    selectResult: opts.selectResult,
    singleResult: opts.singleResult,
    rangeResult: opts.rangeResult,
    inResult: opts.inResult,
    extraChainMethods: opts.extraChainMethods,
  });

  const fromReturn: Record<string, unknown> = {
    select: vi.fn(() => sc.chain),
    upsert,
    insert,
  };
  if (update) {
    fromReturn.update = update;
  }

  const from = opts.fromImpl ?? vi.fn(() => fromReturn);

  const mock = { rpc, from };

  return {
    client: mock as unknown as SupabaseClient,
    rpc,
    from,
    selectChain: sc,
    upsert,
    insert,
    update,
  };
}
