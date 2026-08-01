/**
 * SCRUM-3031: cross-instance run lease for public-record anchoring.
 *
 * OBSERVED IN PRODUCTION 2026-08-01 (Cloud Run `arkova-worker`, revision
 * 01164-xux). `anchor-public-records` is scheduled every 10 minutes with a
 * Cloud Scheduler `attemptDeadline` of 300s, while Cloud Run's request timeout
 * is 3600s. A run that exceeds 300s is abandoned by Cloud Scheduler
 * (`AttemptFinished status=DEADLINE_EXCEEDED`, 19:15:04Z) but keeps executing
 * server-side, so the next tick starts a SECOND run — and Cloud Run places it
 * on a different instance:
 *
 *   19:12:27Z  "Creating individual anchors" recordCount=10000  instance …72908
 *   19:22:26Z  "Creating individual anchors" recordCount=10000  instance …72963
 *
 * Both runs select the SAME 10,000 unlinked records and call
 * `batch_insert_anchors` on the same fingerprints. The resulting row-lock
 * contention pushed each 1,000-row chunk past the 20s client deadline
 * (`AbortError`, chunkIndex 0/1000/2000/3000), so every chunk fell back to
 * `insertAnchorSerialFallback` — 1,000 individual round-trips — which made the
 * run slower still and guaranteed the next overlap. The unlinked backlog did
 * not move (405,376 before and after three consecutive runs).
 *
 * `publicRecordAnchoringRunning` cannot prevent this: it is a per-PROCESS
 * boolean, invisible to another Cloud Run instance. The guard has to be shared
 * state, so it moves into a TTL lease row in `job_queue` claimed by an atomic
 * compare-and-set.
 *
 * These tests pin the lease semantics against an in-memory store that mirrors
 * the CAS predicate, so a regression that reintroduces cross-instance overlap
 * fails here rather than in production.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  config: {
    logLevel: 'info',
    nodeEnv: 'test',
    useMocks: true,
    enableProdNetworkAnchoring: false,
    bitcoinNetwork: 'signet',
    batchAnchorMaxSize: 10_000,
  },
}));

vi.mock('../../utils/logger.js', () => ({ logger: mockLogger }));

vi.mock('../../utils/db.js', () => ({
  db: {},
  withDbTimeout: vi.fn((operation: () => Promise<unknown>) => operation()),
}));

vi.mock('../../chain/client.js', () => ({
  getInitializedChainClient: () => ({ submitFingerprint: vi.fn() }),
  getChainClientAsync: () => Promise.resolve({ submitFingerprint: vi.fn() }),
}));

import {
  PUBLIC_RECORD_ANCHOR_LEASE_ID,
  PUBLIC_RECORD_ANCHOR_LEASE_TTL_MS,
  PUBLIC_RECORD_ANCHOR_LEASE_TYPE,
  acquirePublicRecordAnchorLease,
  processPublicRecordAnchoring,
  publicRecordAnchorLeaseHolder,
  releasePublicRecordAnchorLease,
} from '../publicRecordAnchor.js';

interface LeaseRow {
  id: string;
  type: string;
  status: string;
  scheduled_for: string | null;
  payload: Record<string, unknown>;
}

/**
 * Minimal `job_queue` double implementing exactly the two operations the lease
 * uses: an `upsert(..., { ignoreDuplicates: true })` bootstrap on the primary
 * key, and a compare-and-set `update` whose match predicate is
 * `id = LEASE_ID AND (status = 'completed' OR scheduled_for < now)`.
 *
 * Modelling the predicate (rather than stubbing a boolean) is the point: it is
 * what makes "second concurrent caller is refused" and "expired lease is
 * stealable" real assertions instead of tautologies.
 */
function leaseStore(initial?: LeaseRow) {
  let row: LeaseRow | undefined = initial;

  /**
   * Evaluates the `.or(...)` expression the code under test actually emits,
   * rather than re-stating the predicate here.
   *
   * This matters: an earlier version of this double hard-coded
   * `status === 'completed'` and only regex-extracted the `scheduled_for` half,
   * so mutating or deleting the `status.eq.completed` disjunct left every test
   * green — while against real PostgREST the CAS would match zero rows, acquire
   * would fail closed, and the job would silently stop running forever. Parsing
   * the emitted expression is what makes that mutation fail here.
   */
  function evaluateOr(expression: string | undefined, target: LeaseRow): boolean {
    if (expression === undefined) return false;
    return expression.split(',').some((term) => {
      const [column, operator, ...rest] = term.split('.');
      const value = rest.join('.');
      const actual = (target as unknown as Record<string, string | null>)[column];
      if (operator === 'eq') return actual === value;
      if (operator === 'lt') return actual !== null && actual !== undefined && actual < value;
      throw new Error(`lease double: unsupported operator '${operator}' in '${term}'`);
    });
  }

  function matches(filters: Record<string, string>, orExpression: string | undefined): boolean {
    if (!row) return false;
    if (filters.id !== row.id) return false;
    return evaluateOr(orExpression, row);
  }

  const client = {
    from() {
      const filters: Record<string, string> = {};
      let pending: Partial<LeaseRow> | undefined;
      let orExpression: string | undefined;
      let mode: 'upsert' | 'update' | undefined;
      let releaseHolder: string | undefined;

      const builder: Record<string, unknown> = {};
      builder.upsert = (values: LeaseRow) => {
        mode = 'upsert';
        pending = values;
        return builder;
      };
      builder.update = (values: Partial<LeaseRow>) => {
        mode = 'update';
        pending = values;
        return builder;
      };
      builder.eq = (column: string, value: string) => {
        if (column === "payload->>holder") releaseHolder = value;
        else filters[column] = value;
        return builder;
      };
      builder.or = (expression: string) => {
        orExpression = expression;
        return builder;
      };
      builder.select = () => builder;
      builder.then = (resolve: (v: { data: unknown; error: null }) => unknown) => {
        if (mode === 'upsert') {
          if (!row) row = pending as LeaseRow;
          return Promise.resolve(resolve({ data: null, error: null }));
        }
        if (releaseHolder !== undefined) {
          if (row && row.payload.holder === releaseHolder) {
            row = { ...row, ...(pending as Partial<LeaseRow>) } as LeaseRow;
            return Promise.resolve(resolve({ data: [{ id: row.id }], error: null }));
          }
          return Promise.resolve(resolve({ data: [], error: null }));
        }
        if (matches(filters, orExpression)) {
          row = { ...(row as LeaseRow), ...(pending as Partial<LeaseRow>) };
          return Promise.resolve(resolve({ data: [{ id: row.id }], error: null }));
        }
        return Promise.resolve(resolve({ data: [], error: null }));
      };
      return builder;
    },
  } as unknown as Parameters<typeof acquirePublicRecordAnchorLease>[0];

  return { client, current: () => row };
}

function heldRow(holder: string, expiresAt: string): LeaseRow {
  return {
    id: PUBLIC_RECORD_ANCHOR_LEASE_ID,
    type: PUBLIC_RECORD_ANCHOR_LEASE_TYPE,
    status: 'processing',
    scheduled_for: expiresAt,
    payload: { holder },
  };
}

function freeRow(): LeaseRow {
  return {
    id: PUBLIC_RECORD_ANCHOR_LEASE_ID,
    type: PUBLIC_RECORD_ANCHOR_LEASE_TYPE,
    status: 'completed',
    scheduled_for: null,
    payload: {},
  };
}

describe('public-record anchoring cross-instance lease', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('acquires a free lease and marks it held with a TTL in the future', async () => {
    const store = leaseStore(freeRow());
    const now = new Date('2026-08-01T19:10:00Z');

    const acquired = await acquirePublicRecordAnchorLease(store.client, 'instance-a', now);

    expect(acquired).toBe(true);
    const row = store.current();
    expect(row?.status).toBe('processing');
    expect(row?.payload.holder).toBe('instance-a');
    expect(new Date(row?.scheduled_for as string).getTime()).toBe(
      now.getTime() + PUBLIC_RECORD_ANCHOR_LEASE_TTL_MS,
    );
  });

  // The production failure: two Cloud Run instances, one live lease.
  it('refuses a second instance while another instance holds an unexpired lease', async () => {
    const store = leaseStore(freeRow());
    const now = new Date('2026-08-01T19:12:27Z');

    expect(await acquirePublicRecordAnchorLease(store.client, 'instance-72908', now)).toBe(true);

    const overlapping = new Date('2026-08-01T19:22:26Z'); // the real second run
    expect(await acquirePublicRecordAnchorLease(store.client, 'instance-72963', overlapping)).toBe(
      false,
    );
    expect(store.current()?.payload.holder).toBe('instance-72908');
  });

  it('lets a later run steal a lease whose TTL has expired', async () => {
    const expiry = '2026-08-01T19:00:00Z';
    const store = leaseStore(heldRow('crashed-instance', expiry));

    const acquired = await acquirePublicRecordAnchorLease(
      store.client,
      'instance-b',
      new Date('2026-08-01T19:00:01Z'),
    );

    expect(acquired).toBe(true);
    expect(store.current()?.payload.holder).toBe('instance-b');
  });

  it('releases only its own lease', async () => {
    const store = leaseStore(heldRow('instance-a', '2026-08-01T20:00:00Z'));

    await releasePublicRecordAnchorLease(store.client, 'instance-b');
    expect(store.current()?.status).toBe('processing');
    expect(store.current()?.payload.holder).toBe('instance-a');

    await releasePublicRecordAnchorLease(store.client, 'instance-a');
    expect(store.current()?.status).toBe('completed');
    expect(store.current()?.scheduled_for).toBeNull();
  });

  it('frees the lease for the next run after a release', async () => {
    const store = leaseStore(freeRow());
    const now = new Date('2026-08-01T19:10:00Z');

    await acquirePublicRecordAnchorLease(store.client, 'instance-a', now);
    await releasePublicRecordAnchorLease(store.client, 'instance-a');

    expect(await acquirePublicRecordAnchorLease(store.client, 'instance-b', now)).toBe(true);
  });

  it('fails closed when the lease store errors', async () => {
    const erroring = {
      from: () => {
        const builder: Record<string, unknown> = {};
        const self = () => builder;
        builder.upsert = self;
        builder.update = self;
        builder.eq = self;
        builder.or = self;
        builder.select = self;
        builder.then = (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
          Promise.resolve(resolve({ data: null, error: { message: 'boom' } }));
        return builder;
      },
    } as unknown as Parameters<typeof acquirePublicRecordAnchorLease>[0];

    expect(await acquirePublicRecordAnchorLease(erroring, 'instance-a', new Date())).toBe(false);
  });

  /**
   * The tests above pin the lease PRIMITIVE. This one pins the WIRING — without
   * it, deleting the `acquirePublicRecordAnchorLease` call from
   * `processPublicRecordAnchoring` would leave every other test in this file
   * green while restoring the exact production overlap.
   */
  it('does no pipeline work when the lease is held by another instance', async () => {
    const rpc = vi.fn(async (name: string) =>
      name === 'get_flag' ? { data: true, error: null } : { data: null, error: null },
    );
    const profileSelect = vi.fn(() => ({
      eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: { id: 'admin', org_id: 'org' }, error: null })) })),
    }));
    const publicRecordsSelect = vi.fn(() => {
      throw new Error('public_records must not be read while another instance holds the lease');
    });

    // Lease permanently held by someone else: the CAS UPDATE matches no row.
    const held = leaseStore(heldRow('other-instance', '2099-01-01T00:00:00Z'));
    const client = {
      rpc,
      from: (table: string) => {
        if (table === 'job_queue') return (held.client as unknown as { from: (t: string) => unknown }).from(table);
        if (table === 'profiles') return { select: profileSelect };
        return { select: publicRecordsSelect };
      },
    } as unknown as Parameters<typeof processPublicRecordAnchoring>[0];

    const result = await processPublicRecordAnchoring(client);

    expect(result).toEqual({
      processed: 0,
      anchorsCreated: 0,
      batchId: null,
      merkleRoot: null,
      txId: null,
    });
    expect(publicRecordsSelect).not.toHaveBeenCalled();
    expect(profileSelect).not.toHaveBeenCalled();
    expect(held.current()?.payload.holder).toBe('other-instance');
  });

  it('releases the lease when the run throws', async () => {
    const store = leaseStore(freeRow());
    const rpc = vi.fn(async (name: string) =>
      name === 'get_flag' ? { data: true, error: null } : { data: null, error: null },
    );
    const client = {
      rpc,
      from: (table: string) => {
        if (table === 'job_queue') {
          return (store.client as unknown as { from: (t: string) => unknown }).from(table);
        }
        // profiles lookup explodes — the run must still give the lease back.
        return {
          select: () => ({
            eq: () => ({ single: async () => { throw new Error('profiles exploded'); } }),
          }),
        };
      },
    } as unknown as Parameters<typeof processPublicRecordAnchoring>[0];

    await expect(processPublicRecordAnchoring(client)).rejects.toThrow('profiles exploded');
    expect(store.current()?.status).toBe('completed');
    expect(store.current()?.scheduled_for).toBeNull();
  });

  /**
   * Regression guard for a bug this PR shipped and then fixed. `K_REVISION` is
   * the Cloud Run REVISION name — identical on every instance — and the
   * container's exec-form CMD makes node PID 1 everywhere, so a holder id of
   * `${K_REVISION}:${pid}` was the SAME string on every instance. The release
   * predicate would then match another instance's live lease.
   */
  it('mints a holder id that cannot collide across instances of one revision', async () => {
    const original = process.env.K_REVISION;
    process.env.K_REVISION = 'arkova-worker-01164-xux';
    try {
      const holder = publicRecordAnchorLeaseHolder();
      // Everything a second instance of the same revision would also compute.
      expect(holder.startsWith(`arkova-worker-01164-xux:${process.pid}:`)).toBe(true);
      // ...plus something it could not.
      const nonce = holder.slice(`arkova-worker-01164-xux:${process.pid}:`.length);
      expect(nonce).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    } finally {
      if (original === undefined) delete process.env.K_REVISION;
      else process.env.K_REVISION = original;
    }
  });

  it('keeps the TTL above a full scheduler cadence so a healthy run is never stolen mid-flight', () => {
    // `anchor-public-records` fires every 10 min in live Cloud Scheduler, but
    // scheduler-manifest.ts still records */30 — so the floor is asserted
    // against the SLOWER of the two. A TTL at or below the cadence would let
    // the next tick steal the lease from a run that is still working,
    // reproducing the overlap this lease exists to prevent.
    expect(PUBLIC_RECORD_ANCHOR_LEASE_TTL_MS).toBeGreaterThan(30 * 60_000);
    // ...and below Cloud Run's 3600s request ceiling, so a crashed holder can
    // never block the drain for longer than one abandoned request could run.
    expect(PUBLIC_RECORD_ANCHOR_LEASE_TTL_MS).toBeLessThan(3_600_000);
  });
});
