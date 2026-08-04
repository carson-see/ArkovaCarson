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
 * Minimal interface covering only the methods our job code calls on a
 * SupabaseClient.  Using this instead of a bare object literal lets
 * TypeScript catch shape mismatches between the mock and real call-sites
 * while keeping the cast surface small and explicit.
 */
interface MockSupabaseClient {
  rpc: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
}

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

  // ── Dual-nature (Promise + chainable) methods ──────────────────────
  // Some PostgREST chain methods can appear as either a terminal (awaited for
  // their result) or mid-chain (followed by `.limit()`, `.order()`, etc.).
  // `Object.assign(Promise.resolve(result), chain)` produces a real Promise
  // whose `.then` resolves via the microtask queue, but which also exposes
  // every chain method so callers can continue building the query.  This lets
  // tests do both:
  //   `await supabase.from("t").select().in("id", ids)`          (terminal)
  //   `await supabase.from("t").select().in("id", ids).limit(5)` (mid-chain)

  chain.in = vi.fn(() => Object.assign(Promise.resolve(inResult), chain));

  const mockLimit = vi.fn(() => Object.assign(Promise.resolve(selectResult), chain));
  chain.limit = mockLimit;

  const mockOrder = vi.fn(() => Object.assign(Promise.resolve(selectResult), chain));
  chain.order = mockOrder;

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
 * `job_queue` table double that always GRANTS a run lease (SCRUM-3031).
 *
 * Jobs guarded by a cross-instance TTL lease claim it before doing any work, so
 * a `fromImpl` that does not route `job_queue` makes every such test fail on
 * `upsert is not a function`. Suites that are exercising the job's PIPELINE,
 * not its concurrency guard, route `job_queue` here and get an
 * always-available lease. Lease semantics themselves are pinned separately
 * (see `run-lease.test.ts`), against a store that EVALUATES the compare-and-set
 * predicate rather than granting unconditionally.
 */
export function grantedRunLeaseTable(): Record<string, ReturnType<typeof vi.fn>> {
  const granted = { data: [{ id: 'lease-row' }], error: null };
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const self = () => chain;
  chain.eq = vi.fn(self);
  chain.or = vi.fn(self);
  chain.select = vi.fn(() => Promise.resolve(granted));
  return {
    upsert: vi.fn().mockResolvedValue({ error: null }),
    update: vi.fn(self),
  };
}

// ───────────────────────── run-lease store double ──────────────────────────

/** Shape of the singleton `job_queue` lease row, as the lease code writes it. */
export interface RunLeaseRow {
  id: string;
  type: string;
  status: string;
  scheduled_for: string | null;
  payload: Record<string, unknown>;
}

/** The subset of `RunLeaseSpec` the double needs, kept local to avoid a cycle. */
interface RunLeaseSpecLike {
  leaseId: string;
  leaseType: string;
}

export type RunLeaseStoreSeed =
  | 'free'
  | 'absent'
  | { held: { holder: string; expiresAt: string } };

export interface RunLeaseStore {
  /** Pass straight into `acquireRunLease` / `withRunLease({ client })`. */
  client: SupabaseClient;
  /** Route this from a per-table `fromImpl`, for wiring tests. */
  from: (table: string) => unknown;
  /** Current row, or undefined before the bootstrap upsert has run. */
  current: () => RunLeaseRow | undefined;
  /** Terminal store operations performed so far — pins "did not touch the store". */
  callCount: () => number;
  /**
   * Holder-scoped writes ATTEMPTED (renew + release), counted even when
   * `failOwnedWrites` turns them into store errors. Lets a test distinguish
   * "the heartbeat stopped firing" from "the heartbeat fired and was refused".
   */
  ownedWriteAttempts: () => number;
  /**
   * Another instance takes the lease mid-run. Rewrites the holder directly
   * rather than going through the CAS, because the interesting case is the one
   * the CAS cannot produce on demand: the row is stolen while the original
   * run is still executing.
   */
  steal: (holder: string) => void;
}

export interface RunLeaseStoreOptions {
  /**
   * Fail the first N holder-scoped writes with a store ERROR (not a zero-row
   * match). PostgREST reaches this store through a 23-backend pool, so a
   * renewal can fail transiently while the lease is still perfectly ours —
   * a state the code must not confuse with "the lease is gone".
   */
  failOwnedWrites?: number;
}

/**
 * In-memory `job_queue` double for the cross-instance run lease (SCRUM-3031).
 *
 * It implements exactly the two operations the lease uses: an
 * `upsert(…, { ignoreDuplicates: true })` bootstrap on the primary key, and a
 * compare-and-set `update` whose match predicate is
 * `id = <leaseId> AND (status = 'completed' OR scheduled_for < now)`.
 *
 * **It EVALUATES the `.or(...)` expression the code under test emits rather
 * than re-stating the predicate here**, and that is the whole point. An earlier
 * version of this double hard-coded `status === 'completed'` and only
 * regex-extracted the `scheduled_for` half, so mutating or deleting the
 * `status.eq.completed` disjunct left every test green — while against real
 * PostgREST the CAS would match zero rows, acquire would fail closed, and the
 * job would silently stop running forever. Parsing the emitted expression is
 * what makes that mutation fail here.
 *
 * INC-2026-08-04: it also enforces PostgREST's projection rule for UPDATEs —
 * every column named in the `or=` filter must appear in the `select=`
 * projection, or the real server answers `42703 column job_queue.<col> does
 * not exist`. `builder.select` used to discard its argument entirely, so
 * `.select('id')` looked fine here while it hard-failed every CAS in prod and
 * silently stopped every lease-guarded job. The double now returns that same
 * error, which is what makes narrowing the projection fail in CI instead of
 * in production.
 */
export function createRunLeaseStore(
  spec: RunLeaseSpecLike,
  seed: RunLeaseStoreSeed = 'free',
  options: RunLeaseStoreOptions = {},
): RunLeaseStore {
  let row: RunLeaseRow | undefined = seedRow(spec, seed);
  let calls = 0;
  let ownedWriteAttempts = 0;
  let ownedWritesLeftToFail = options.failOwnedWrites ?? 0;

  function evaluateOr(expression: string | undefined, target: RunLeaseRow): boolean {
    if (expression === undefined) return false;
    return expression.split(',').some((term) => {
      const [column, operator, ...rest] = term.split('.');
      const value = rest.join('.');
      const actual = (target as unknown as Record<string, string | null>)[column];
      if (operator === 'eq') return actual === value;
      if (operator === 'lt') return actual !== null && actual !== undefined && actual < value;
      throw new Error(`run-lease double: unsupported operator '${operator}' in '${term}'`);
    });
  }

  /**
   * PostgREST resolves an UPDATE's `or=` filter against the `select=`
   * projection. Return the first filter column the projection omits, so the
   * caller can answer exactly as the server does.
   */
  function missingFilterColumn(
    expression: string | undefined,
    projection: string | undefined,
  ): string | undefined {
    if (expression === undefined || projection === undefined) return undefined;
    const selected = projection.split(',').map((column) => column.trim());
    if (selected.includes('*')) return undefined;
    return expression
      .split(',')
      .map((term) => term.split('.')[0].trim())
      .find((column) => column.length > 0 && !selected.includes(column));
  }

  function from(): Record<string, unknown> {
    const filters: Record<string, string> = {};
    let pending: Partial<RunLeaseRow> | undefined;
    let orExpression: string | undefined;
    let mode: 'upsert' | 'update' | undefined;
    let releaseHolder: string | undefined;
    let projection: string | undefined;

    const builder: Record<string, unknown> = {};
    builder.upsert = (values: RunLeaseRow) => {
      mode = 'upsert';
      pending = values;
      return builder;
    };
    builder.update = (values: Partial<RunLeaseRow>) => {
      mode = 'update';
      pending = values;
      return builder;
    };
    builder.eq = (column: string, value: string) => {
      if (column === 'payload->>holder') releaseHolder = value;
      else filters[column] = value;
      return builder;
    };
    builder.or = (expression: string) => {
      orExpression = expression;
      return builder;
    };
    builder.select = (columns?: string) => {
      projection = columns;
      return builder;
    };
    builder.then = (resolve: (v: { data: unknown; error: unknown }) => unknown) => {
      calls += 1;
      // Real PostgREST rejects the whole statement before it matches any row.
      const omitted = mode === 'update' ? missingFilterColumn(orExpression, projection) : undefined;
      if (omitted !== undefined) {
        return Promise.resolve(
          resolve({
            data: null,
            error: {
              code: '42703',
              details: null,
              hint: null,
              message: `column job_queue.${omitted} does not exist`,
            },
          }),
        );
      }
      if (mode === 'upsert') {
        // `ignoreDuplicates: true` on the primary key: create once, never clobber.
        if (!row) row = pending as RunLeaseRow;
        return Promise.resolve(resolve({ data: null, error: null }));
      }
      const idMatches = row !== undefined && filters.id === row.id;
      if (releaseHolder !== undefined) {
        ownedWriteAttempts += 1;
        if (ownedWritesLeftToFail > 0) {
          ownedWritesLeftToFail -= 1;
          return Promise.resolve(resolve({ data: null, error: { message: 'ETIMEDOUT' } }));
        }
        if (idMatches && row?.payload.holder === releaseHolder) {
          row = { ...(row as RunLeaseRow), ...(pending as Partial<RunLeaseRow>) };
          return Promise.resolve(resolve({ data: [{ id: row.id }], error: null }));
        }
        return Promise.resolve(resolve({ data: [], error: null }));
      }
      if (idMatches && evaluateOr(orExpression, row as RunLeaseRow)) {
        row = { ...(row as RunLeaseRow), ...(pending as Partial<RunLeaseRow>) };
        return Promise.resolve(resolve({ data: [{ id: row.id }], error: null }));
      }
      return Promise.resolve(resolve({ data: [], error: null }));
    };
    return builder;
  }

  return {
    client: { from } as unknown as SupabaseClient,
    from,
    current: () => row,
    callCount: () => calls,
    ownedWriteAttempts: () => ownedWriteAttempts,
    steal: (holder: string) => {
      if (row) row = { ...row, payload: { ...row.payload, holder } };
    },
  };
}

function seedRow(spec: RunLeaseSpecLike, seed: RunLeaseStoreSeed): RunLeaseRow | undefined {
  if (seed === 'absent') return undefined;
  const base = { id: spec.leaseId, type: spec.leaseType };
  if (seed === 'free') {
    return { ...base, status: 'completed', scheduled_for: null, payload: {} };
  }
  return {
    ...base,
    status: 'processing',
    scheduled_for: seed.held.expiresAt,
    payload: { holder: seed.held.holder },
  };
}

/**
 * A lease client whose store is broken, for the fail-CLOSED assertions. A run
 * without a verified lease is exactly the concurrent execution the lease
 * guards against, so an unverifiable lease must skip the run, not proceed on
 * optimism.
 */
export function erroringRunLeaseClient(opts: {
  failOn: 'upsert' | 'update' | 'throw';
}): SupabaseClient {
  return {
    from: () => {
      let mode: 'upsert' | 'update' | undefined;
      const builder: Record<string, unknown> = {};
      const self = () => builder;
      builder.upsert = () => {
        mode = 'upsert';
        return builder;
      };
      builder.update = () => {
        mode = 'update';
        return builder;
      };
      builder.eq = self;
      builder.or = self;
      builder.select = self;
      builder.then = (resolve: (v: { data: unknown; error: unknown }) => unknown) => {
        if (opts.failOn === 'throw') throw new Error('lease store unreachable');
        const failed = mode === opts.failOn;
        return Promise.resolve(
          resolve({ data: failed ? null : [], error: failed ? { message: 'boom' } : null }),
        );
      };
      return builder;
    },
  } as unknown as SupabaseClient;
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

  const mock: MockSupabaseClient = { rpc, from };

  return {
    // MockSupabaseClient is structurally compatible with the subset of
    // SupabaseClient that job code uses.  The single narrowing cast here
    // replaces ~35 scattered `as unknown as SupabaseClient` across tests.
    client: mock as unknown as SupabaseClient,
    rpc,
    from,
    selectChain: sc,
    upsert,
    insert,
    update,
  };
}
