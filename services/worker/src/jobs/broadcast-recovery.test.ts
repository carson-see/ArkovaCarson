/**
 * broadcast-recovery.ts — dedicated unit coverage.
 *
 * Prior to F-3 (docs/staging/SOAK-FINDINGS-2026-08.md, migration 0379) this
 * job had no dedicated test file at all; its RPC-success path was only
 * exercised indirectly through `batch-drain-reconcile.test.ts`'s larger
 * end-to-end harness, and the `manualRecovery` JS fallback (used only when
 * the `recover_stuck_broadcasts` RPC itself is unavailable — e.g. schema
 * cache lag right after a fresh deploy, or a pre-0358 database) had NO
 * coverage whatsoever. This file closes both gaps and pins the F-3 SUBMITTED
 * extension at the unit level with a purpose-built, minimal query-builder
 * mock (independent of the larger batch-drain harness).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Controllable mocks ──────────────────────────────────────────────────────

const mockReconcileTxidJournals = vi.fn();
vi.mock('./batch-anchor.js', () => ({
  reconcileTxidJournals: (...args: unknown[]) => mockReconcileTxidJournals(...args),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

type AnchorFixture = {
  id: string;
  fingerprint: string;
  status: 'BROADCASTING' | 'SUBMITTED' | 'PENDING';
  chain_tx_id: string | null;
  deleted_at: string | null;
  updated_at: string;
  metadata: Record<string, unknown> | null;
};

let anchorRows: AnchorFixture[] = [];
let journalProtectedIds: string[] = [];
let journalError: { code?: string; message?: string } | null = null;
const updateCalls: Array<{ id: string; expectStatus: string; payload: Record<string, unknown> }> = [];
/** Anchor ids whose UPDATE should simulate a failure (rejected/errored). */
let failUpdateIds: Set<string> = new Set();
/** Every SELECT the manual fallback issued — the bounded-batch evidence. */
const selectCalls: Array<{ limit: number | null; orderAscending: boolean | null; returned: number }> = [];
/** When set, every anchors SELECT fails with this error (e.g. statement timeout). */
let selectFetchError: { code?: string; message?: string } | null = null;

function resetFixtures(): void {
  anchorRows = [];
  journalProtectedIds = [];
  journalError = null;
  updateCalls.length = 0;
  selectCalls.length = 0;
  selectFetchError = null;
  failUpdateIds = new Set();
}

/** Minimal PostgREST-style query-builder shim — only the methods broadcast-recovery.ts uses. */
function makeAnchorsQuery() {
  let mode: 'select' | 'update' = 'select';
  let statusIn: string[] | null = null;
  let chainTxIdNull = false;
  let deletedAtNull = false;
  let updatedBefore: string | null = null;
  let updatePayload: Record<string, unknown> = {};
  let selectLimit: number | null = null;
  let orderAscending: boolean | null = null;
  let updateId: string | null = null;
  let updateExpectStatus: string | null = null;

  const api: Record<string, unknown> = {};
  api.select = () => api;
  api.update = (payload: Record<string, unknown>) => {
    mode = 'update';
    updatePayload = payload;
    return api;
  };
  api.in = (col: string, vals: string[]) => {
    if (col === 'status') statusIn = vals;
    return api;
  };
  api.is = (col: string, val: unknown) => {
    if (col === 'chain_tx_id' && val === null) chainTxIdNull = true;
    if (col === 'deleted_at' && val === null) deletedAtNull = true;
    return api;
  };
  api.lt = (col: string, val: string) => {
    if (col === 'updated_at') updatedBefore = val;
    return api;
  };
  api.limit = (n: number) => {
    selectLimit = n;
    return api;
  };
  api.order = (col: string, opts?: { ascending?: boolean }) => {
    if (col === 'updated_at') orderAscending = opts?.ascending !== false;
    return api;
  };
  api.eq = (col: string, val: string) => {
    if (mode === 'update' && col === 'id') updateId = val;
    if (mode === 'update' && col === 'status') updateExpectStatus = val;
    return api;
  };
  api.then = (resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
    try {
      if (mode === 'select') {
        if (selectFetchError) {
          selectCalls.push({ limit: selectLimit, orderAscending, returned: 0 });
          return Promise.resolve({ data: null, error: selectFetchError }).then(resolve, reject);
        }
        let rows = anchorRows.filter((a) => {
          if (statusIn && !statusIn.includes(a.status)) return false;
          if (chainTxIdNull && a.chain_tx_id !== null) return false;
          if (deletedAtNull && a.deleted_at !== null) return false;
          if (updatedBefore && !(a.updated_at < updatedBefore)) return false;
          return true;
        });
        if (orderAscending !== null) {
          rows = [...rows].sort((a, b) =>
            orderAscending ? a.updated_at.localeCompare(b.updated_at) : b.updated_at.localeCompare(a.updated_at),
          );
        }
        // PostgREST applies the row cap server-side; the mock must too, or a
        // "bounded batch" assertion can never fail.
        if (selectLimit !== null) rows = rows.slice(0, selectLimit);
        selectCalls.push({ limit: selectLimit, orderAscending, returned: rows.length });
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      }
      // update
      if (updateId && failUpdateIds.has(updateId)) {
        return Promise.resolve({ data: null, error: { message: 'simulated update failure' } }).then(resolve, reject);
      }
      updateCalls.push({ id: updateId!, expectStatus: updateExpectStatus!, payload: updatePayload });
      const row = anchorRows.find((a) => a.id === updateId);
      if (row && updateExpectStatus && row.status === updateExpectStatus) {
        Object.assign(row, updatePayload);
      }
      return Promise.resolve({ data: null, error: null }).then(resolve, reject);
    } catch (e) {
      return Promise.reject(e as Error).then(resolve, reject);
    }
  };
  return api;
}

function makeJournalQuery() {
  const api: Record<string, unknown> = {};
  api.select = () => api;
  api.in = () => api;
  api.limit = () => api;
  api.then = (resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
    if (journalError) {
      return Promise.resolve({ data: null, error: journalError }).then(resolve, reject);
    }
    return Promise.resolve({
      data: journalProtectedIds.length > 0 ? [{ anchor_ids: journalProtectedIds }] : [],
      error: null,
    }).then(resolve, reject);
  };
  return api;
}

const mockRpc = vi.fn();

vi.mock('../utils/db.js', () => ({
  db: {
    from: (table: string) => {
      if (table === 'anchors') return makeAnchorsQuery();
      if (table === 'anchor_txid_journal') return makeJournalQuery();
      throw new Error(`unexpected table ${table}`);
    },
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));

const { recoverStuckBroadcasts, RECOVERY_BATCH_SIZE, MAX_RECOVERY_PASSES } = await import(
  './broadcast-recovery.js'
);
const { logger } = await import('../utils/logger.js');

beforeEach(() => {
  vi.clearAllMocks();
  resetFixtures();
  mockReconcileTxidJournals.mockResolvedValue({
    protectionLoaded: true,
    scanned: 0,
    adopted: 0,
    reverted: 0,
    held: 0,
  });
});

describe('recoverStuckBroadcasts — RPC path', () => {
  it('refuses recovery when txid journal protection failed to load (fails closed, RPC never called)', async () => {
    mockReconcileTxidJournals.mockResolvedValue({ protectionLoaded: false, scanned: 0, adopted: 0, reverted: 0, held: 0 });

    const result = await recoverStuckBroadcasts(5);

    expect(result).toMatchObject({ recovered: 0, anchors: [] });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Txid journal protection unavailable'),
    );
  });

  it('calls the RPC with the given stale-minutes threshold and maps rows (BROADCASTING + SUBMITTED recoveries indistinguishable at this layer, per migration 0379 unchanged-signature design)', async () => {
    mockRpc.mockResolvedValue({
      data: [
        { anchor_id: 'a1', anchor_fingerprint: 'fp1', claimed_by: 'worker-1', stuck_since: '2026-08-01T00:00:00Z' },
        { anchor_id: 'a2', anchor_fingerprint: 'fp2', claimed_by: null, stuck_since: '2026-08-01T00:00:00Z' },
      ],
      error: null,
    });

    const result = await recoverStuckBroadcasts(7);

    // SCRUM-4520: the call is now bounded — p_limit is part of the contract.
    expect(mockRpc).toHaveBeenCalledWith('recover_stuck_broadcasts', {
      p_stale_minutes: 7,
      p_limit: RECOVERY_BATCH_SIZE,
    });
    expect(result.recovered).toBe(2);
    expect(result.anchors).toEqual([
      { id: 'a1', fingerprint: 'fp1', claimedBy: 'worker-1' },
      { id: 'a2', fingerprint: 'fp2', claimedBy: 'unknown' }, // null claimed_by defaults to 'unknown'
    ]);
  });

  it('returns recovered:0 when the RPC returns no rows', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    const result = await recoverStuckBroadcasts(5);
    expect(result).toMatchObject({ recovered: 0, anchors: [] });
  });

  it('falls back to manualRecovery when the RPC itself errors', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'function not found' } });
    // No fixtures seeded → manualRecovery's SELECT returns [] → recovered:0.
    // The important assertion is that it does NOT throw and does NOT report
    // the RPC's error as a hard failure.
    const result = await recoverStuckBroadcasts(5);
    expect(result).toMatchObject({ recovered: 0, anchors: [] });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: { code: 'PGRST202', message: 'function not found' } }),
      expect.stringContaining('falling back to manual recovery'),
    );
  });
});

describe('recoverStuckBroadcasts — manualRecovery fallback (F-3, migration 0379)', () => {
  function forceRpcUnavailable(): void {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'function not found' } });
  }

  it('refuses recovery when the journal protection scan itself fails (ambiguous — fails closed)', async () => {
    forceRpcUnavailable();
    journalError = { code: '42501', message: 'permission denied' };
    anchorRows = [
      {
        id: 'stale-1',
        fingerprint: 'fp-stale-1',
        status: 'SUBMITTED',
        chain_tx_id: null,
        deleted_at: null,
        updated_at: '2020-01-01T00:00:00.000Z',
        metadata: {},
      },
    ];

    const result = await recoverStuckBroadcasts(5);
    expect(result).toMatchObject({ recovered: 0, anchors: [] });
    expect(updateCalls).toHaveLength(0);
  });

  it('reclaims a stale SUBMITTED+NULL-chain_tx_id row (the F-3 fix), tagged with the new reason', async () => {
    forceRpcUnavailable();
    anchorRows = [
      {
        id: 'submitted-stuck',
        fingerprint: 'fp-submitted',
        status: 'SUBMITTED',
        chain_tx_id: null,
        deleted_at: null,
        updated_at: '2020-01-01T00:00:00.000Z',
        metadata: { _claimed_by: 'worker-9', foo: 'bar' },
      },
    ];

    const result = await recoverStuckBroadcasts(5);

    expect(result.recovered).toBe(1);
    expect(result.anchors).toEqual([{ id: 'submitted-stuck', fingerprint: 'fp-submitted', claimedBy: 'worker-9' }]);

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].expectStatus).toBe('SUBMITTED'); // compare-and-set on the row's OWN previous status
    expect(updateCalls[0].payload.status).toBe('PENDING');
    const metadata = updateCalls[0].payload.metadata as Record<string, unknown>;
    expect(metadata._recovery_reason).toBe('stuck_submitted_null_txid');
    expect(metadata._recovered_from_status).toBe('SUBMITTED');
    expect(metadata._previous_claimed_by).toBe('worker-9');
    expect(metadata.foo).toBe('bar'); // existing metadata preserved
    expect(metadata._claimed_by).toBeUndefined(); // claim residue cleaned up

    // Store actually reflects the recovery.
    expect(anchorRows[0].status).toBe('PENDING');
  });

  it('still reclaims a stale BROADCASTING+NULL-chain_tx_id row, tagged with the pre-existing reason (regression guard)', async () => {
    forceRpcUnavailable();
    anchorRows = [
      {
        id: 'broadcasting-stuck',
        fingerprint: 'fp-broadcasting',
        status: 'BROADCASTING',
        chain_tx_id: null,
        deleted_at: null,
        updated_at: '2020-01-01T00:00:00.000Z',
        metadata: { _claimed_by: 'worker-3' },
      },
    ];

    const result = await recoverStuckBroadcasts(5);

    expect(result.recovered).toBe(1);
    expect(updateCalls[0].expectStatus).toBe('BROADCASTING');
    const metadata = updateCalls[0].payload.metadata as Record<string, unknown>;
    expect(metadata._recovery_reason).toBe('stuck_broadcasting'); // byte-for-byte preserved string
    expect(metadata._recovered_from_status).toBe('BROADCASTING');
  });

  it('a mixed BROADCASTING+SUBMITTED cohort: each row gets its OWN reason/filter, never cross-tagged', async () => {
    forceRpcUnavailable();
    anchorRows = [
      {
        id: 'mix-broadcasting',
        fingerprint: 'fp-mix-b',
        status: 'BROADCASTING',
        chain_tx_id: null,
        deleted_at: null,
        updated_at: '2020-01-01T00:00:00.000Z',
        metadata: {},
      },
      {
        id: 'mix-submitted',
        fingerprint: 'fp-mix-s',
        status: 'SUBMITTED',
        chain_tx_id: null,
        deleted_at: null,
        updated_at: '2020-01-01T00:00:00.000Z',
        metadata: {},
      },
    ];

    const result = await recoverStuckBroadcasts(5);

    expect(result.recovered).toBe(2);
    const byId = new Map(updateCalls.map((c) => [c.id, c]));
    expect(byId.get('mix-broadcasting')!.expectStatus).toBe('BROADCASTING');
    expect((byId.get('mix-broadcasting')!.payload.metadata as Record<string, unknown>)._recovery_reason).toBe(
      'stuck_broadcasting',
    );
    expect(byId.get('mix-submitted')!.expectStatus).toBe('SUBMITTED');
    expect((byId.get('mix-submitted')!.payload.metadata as Record<string, unknown>)._recovery_reason).toBe(
      'stuck_submitted_null_txid',
    );
  });

  it('NEVER reclaims a SUBMITTED row with a real chain_tx_id, even if stale (double-broadcast guard)', async () => {
    forceRpcUnavailable();
    anchorRows = [
      {
        id: 'submitted-with-tx',
        fingerprint: 'fp-with-tx',
        status: 'SUBMITTED',
        chain_tx_id: 'a'.repeat(64),
        deleted_at: null,
        updated_at: '2020-01-01T00:00:00.000Z',
        metadata: {},
      },
    ];

    const result = await recoverStuckBroadcasts(5);
    expect(result).toMatchObject({ recovered: 0, anchors: [] });
    expect(updateCalls).toHaveLength(0);
    expect(anchorRows[0].status).toBe('SUBMITTED');
  });

  it('excludes a SUBMITTED+NULL-chain_tx_id row protected by an unresolved anchor_txid_journal cohort', async () => {
    forceRpcUnavailable();
    journalProtectedIds = ['journal-protected'];
    anchorRows = [
      {
        id: 'journal-protected',
        fingerprint: 'fp-protected',
        status: 'SUBMITTED',
        chain_tx_id: null,
        deleted_at: null,
        updated_at: '2020-01-01T00:00:00.000Z',
        metadata: {},
      },
    ];

    const result = await recoverStuckBroadcasts(5);
    expect(result).toMatchObject({ recovered: 0, anchors: [] });
    expect(updateCalls).toHaveLength(0);
  });

  it('a failed per-row UPDATE is logged and excluded from the recovered count, without blocking the rest of the chunk', async () => {
    forceRpcUnavailable();
    anchorRows = [
      {
        id: 'will-fail',
        fingerprint: 'fp-fail',
        status: 'SUBMITTED',
        chain_tx_id: null,
        deleted_at: null,
        updated_at: '2020-01-01T00:00:00.000Z',
        metadata: {},
      },
      {
        id: 'will-succeed',
        fingerprint: 'fp-ok',
        status: 'SUBMITTED',
        chain_tx_id: null,
        deleted_at: null,
        updated_at: '2020-01-01T00:00:00.000Z',
        metadata: {},
      },
    ];
    failUpdateIds = new Set(['will-fail']);

    const result = await recoverStuckBroadcasts(5);

    expect(result.recovered).toBe(1);
    expect(result.anchors).toEqual([{ id: 'will-succeed', fingerprint: 'fp-ok', claimedBy: 'unknown' }]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ anchorId: 'will-fail' }),
      'Recovery update failed for anchor',
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SCRUM-4520 — bounded batching (2026-09-07 rig txvvrxngyfnnqahujbld incident)
//
// A batch-anchoring run was SIGTERM'd mid-flight on the oldest-worker-0905
// staging rig, leaving 10,000 anchors BROADCASTING with a NULL chain_tx_id.
// `POST /jobs/recover-broadcasts` returned 200 on every pass and recovered
// NOTHING for ~10 minutes:
//
//   * `recover_stuck_broadcasts()` took no LIMIT, so its single UPDATE tried
//     to claim all 10,000 rows and died on the function's own 60s
//     `statement_timeout` (SQLSTATE 57014) every time.
//   * The 57014 was routed into `manualRecovery` — a fallback written for
//     "the RPC does not exist yet" — which SELECTed 10,000 rows and fired
//     10,000 individual PostgREST UPDATEs, 100 concurrently. That is what
//     drove the rig's PostgREST into Cloudflare 520s.
//   * `manualRecovery` returned `{recovered: 0}` for a fetch error and a
//     genuinely-empty cohort alike, and logged only when it recovered
//     something — so a total stall was indistinguishable from "nothing to do".
//
// A stuck BROADCASTING cohort head-of-line blocks batch anchoring
// (`batch_insert_anchors` keeps returning the same oldest-first rows), so this
// is a liveness bug: the queue does not drain until the cohort clears.
// ────────────────────────────────────────────────────────────────────────────

describe('recoverStuckBroadcasts — bounded batching (SCRUM-4520)', () => {
  /** Models the real RPC: claims at most `p_limit` rows out of a live cohort. */
  function seedRpcCohort(size: number): { remaining: () => number; limitsSeen: number[] } {
    let remaining = size;
    const limitsSeen: number[] = [];
    mockRpc.mockImplementation(async (_fn: string, params: { p_limit?: number }) => {
      const limit = params.p_limit ?? Number.POSITIVE_INFINITY;
      limitsSeen.push(limit);
      const take = Math.min(limit, remaining);
      remaining -= take;
      return {
        data: Array.from({ length: take }, (_, i) => ({
          anchor_id: `stuck-${size - remaining - take + i}`,
          anchor_fingerprint: `fp-${i}`,
          claimed_by: 'worker-sigterm',
          stuck_since: '2026-09-07T00:00:00Z',
        })),
        error: null,
      };
    });
    return { remaining: () => remaining, limitsSeen };
  }

  it('asks the RPC for a bounded batch — one call can never try to claim the whole cohort', async () => {
    const cohort = seedRpcCohort(10_000);

    await recoverStuckBroadcasts(5);

    expect(RECOVERY_BATCH_SIZE).toBeGreaterThan(0);
    expect(RECOVERY_BATCH_SIZE).toBeLessThanOrEqual(1_000);
    // Every single call is bounded — this is the assertion that would have
    // caught the unbounded RPC that timed out at 60s on 10k rows.
    for (const limit of cohort.limitsSeen) {
      expect(limit).toBe(RECOVERY_BATCH_SIZE);
    }
    expect(mockRpc).toHaveBeenCalledWith(
      'recover_stuck_broadcasts',
      expect.objectContaining({ p_stale_minutes: 5, p_limit: RECOVERY_BATCH_SIZE }),
    );
  });

  it('drains a 10,000-row cohort across repeated bounded calls in a single invocation', async () => {
    const cohort = seedRpcCohort(10_000);

    const result = await recoverStuckBroadcasts(5);

    expect(result.recovered).toBe(10_000);
    expect(cohort.remaining()).toBe(0);
    // Bounded batches ⇒ many calls, not one giant one.
    expect(mockRpc.mock.calls.length).toBeGreaterThanOrEqual(10_000 / RECOVERY_BATCH_SIZE);
    expect(result.passes).toBe(mockRpc.mock.calls.length);
    expect(result.incomplete).toBe(false);
  });

  it('stops at the pass cap and reports incomplete rather than looping forever', async () => {
    seedRpcCohort(Number.MAX_SAFE_INTEGER);

    const result = await recoverStuckBroadcasts(5);

    expect(result.passes).toBe(MAX_RECOVERY_PASSES);
    expect(result.incomplete).toBe(true);
    expect(result.recovered).toBe(MAX_RECOVERY_PASSES * RECOVERY_BATCH_SIZE);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ incomplete: true }),
      expect.stringContaining('pass budget'),
    );
  });

  it('does NOT fan out to manualRecovery on a statement timeout — that is what melted the rig', async () => {
    anchorRows = Array.from({ length: 200 }, (_, i) => ({
      id: `stuck-${i}`,
      fingerprint: `fp-${i}`,
      status: 'BROADCASTING' as const,
      chain_tx_id: null,
      deleted_at: null,
      updated_at: '2020-01-01T00:00:00.000Z',
      metadata: {},
    }));
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: '57014', message: 'canceling statement due to statement timeout' },
    });

    const result = await recoverStuckBroadcasts(5);

    expect(result.recovered).toBe(0);
    expect(result.incomplete).toBe(true);
    // The whole point: no 200-row JS fan-out behind a timing-out database.
    expect(updateCalls).toHaveLength(0);
    expect(selectCalls).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: '57014' }) }),
      expect.stringContaining('recover_stuck_broadcasts RPC failed'),
    );
  });

  it('still falls back to manualRecovery when the RPC is genuinely absent (schema-cache lag / pre-0358 db)', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'function not found' } });
    anchorRows = [
      {
        id: 'absent-rpc-1',
        fingerprint: 'fp-absent',
        status: 'BROADCASTING',
        chain_tx_id: null,
        deleted_at: null,
        updated_at: '2020-01-01T00:00:00.000Z',
        metadata: {},
      },
    ];

    const result = await recoverStuckBroadcasts(5);

    expect(result.recovered).toBe(1);
    expect(selectCalls.length).toBeGreaterThan(0);
  });
});

describe('manualRecovery — bounded batching + visibility (SCRUM-4520)', () => {
  function forceRpcUnavailable(): void {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'function not found' } });
  }

  function seedStuck(count: number): void {
    anchorRows = Array.from({ length: count }, (_, i) => ({
      id: `manual-${String(i).padStart(6, '0')}`,
      fingerprint: `fp-${i}`,
      status: 'BROADCASTING' as const,
      chain_tx_id: null,
      deleted_at: null,
      // Distinct, ascending timestamps so oldest-first ordering is observable.
      updated_at: new Date(Date.UTC(2020, 0, 1) + i * 1000).toISOString(),
      metadata: {},
    }));
  }

  it('never SELECTs more than one bounded batch per pass', async () => {
    forceRpcUnavailable();
    seedStuck(10_000);

    await recoverStuckBroadcasts(5);

    expect(selectCalls.length).toBeGreaterThan(1);
    for (const call of selectCalls) {
      expect(call.limit).toBe(RECOVERY_BATCH_SIZE);
      expect(call.returned).toBeLessThanOrEqual(RECOVERY_BATCH_SIZE);
    }
  });

  it('drains a 10,000-row cohort across repeated passes, oldest first', async () => {
    forceRpcUnavailable();
    seedStuck(10_000);

    const result = await recoverStuckBroadcasts(5);

    expect(result.recovered).toBe(10_000);
    expect(anchorRows.every((a) => a.status === 'PENDING')).toBe(true);
    // Head-of-line blockers clear first.
    expect(selectCalls.every((c) => c.orderAscending === true)).toBe(true);
    expect(updateCalls[0].id).toBe('manual-000000');
  });

  it('logs how many rows each pass actually recovered, so a stall is visible not silent', async () => {
    forceRpcUnavailable();
    seedStuck(RECOVERY_BATCH_SIZE + 10);

    await recoverStuckBroadcasts(5);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ pass: 1, fetched: RECOVERY_BATCH_SIZE, recovered: RECOVERY_BATCH_SIZE }),
      expect.stringContaining('Manual recovery pass'),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ pass: 2, fetched: 10, recovered: 10 }),
      expect.stringContaining('Manual recovery pass'),
    );
  });

  it('reports a SELECT failure loudly instead of returning a silent recovered:0', async () => {
    forceRpcUnavailable();
    seedStuck(50);
    selectFetchError = { code: '57014', message: 'canceling statement due to statement timeout' };

    const result = await recoverStuckBroadcasts(5);

    expect(result.recovered).toBe(0);
    expect(result.incomplete).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: '57014' }) }),
      expect.stringContaining('Manual recovery fetch failed'),
    );
  });

  it('a pass that recovers zero of the rows it fetched stops the loop instead of spinning', async () => {
    forceRpcUnavailable();
    seedStuck(RECOVERY_BATCH_SIZE * 3);
    failUpdateIds = new Set(anchorRows.map((a) => a.id));

    const result = await recoverStuckBroadcasts(5);

    expect(result.recovered).toBe(0);
    expect(result.incomplete).toBe(true);
    // One fetch, one failed attempt at it, then stop — not an infinite re-read
    // of the same rows the database refuses to update.
    expect(selectCalls).toHaveLength(1);
  });
});
