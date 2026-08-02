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

function resetFixtures(): void {
  anchorRows = [];
  journalProtectedIds = [];
  journalError = null;
  updateCalls.length = 0;
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
  api.limit = () => api;
  api.eq = (col: string, val: string) => {
    if (mode === 'update' && col === 'id') updateId = val;
    if (mode === 'update' && col === 'status') updateExpectStatus = val;
    return api;
  };
  api.then = (resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
    try {
      if (mode === 'select') {
        const rows = anchorRows.filter((a) => {
          if (statusIn && !statusIn.includes(a.status)) return false;
          if (chainTxIdNull && a.chain_tx_id !== null) return false;
          if (deletedAtNull && a.deleted_at !== null) return false;
          if (updatedBefore && !(a.updated_at < updatedBefore)) return false;
          return true;
        });
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

const { recoverStuckBroadcasts } = await import('./broadcast-recovery.js');
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

    expect(result).toEqual({ recovered: 0, anchors: [] });
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

    expect(mockRpc).toHaveBeenCalledWith('recover_stuck_broadcasts', { p_stale_minutes: 7 });
    expect(result.recovered).toBe(2);
    expect(result.anchors).toEqual([
      { id: 'a1', fingerprint: 'fp1', claimedBy: 'worker-1' },
      { id: 'a2', fingerprint: 'fp2', claimedBy: 'unknown' }, // null claimed_by defaults to 'unknown'
    ]);
  });

  it('returns recovered:0 when the RPC returns no rows', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    const result = await recoverStuckBroadcasts(5);
    expect(result).toEqual({ recovered: 0, anchors: [] });
  });

  it('falls back to manualRecovery when the RPC itself errors', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'function not found' } });
    // No fixtures seeded → manualRecovery's SELECT returns [] → recovered:0.
    // The important assertion is that it does NOT throw and does NOT report
    // the RPC's error as a hard failure.
    const result = await recoverStuckBroadcasts(5);
    expect(result).toEqual({ recovered: 0, anchors: [] });
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
    expect(result).toEqual({ recovered: 0, anchors: [] });
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
    expect(result).toEqual({ recovered: 0, anchors: [] });
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
    expect(result).toEqual({ recovered: 0, anchors: [] });
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
