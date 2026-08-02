/**
 * SCRUM-3031: `processBatchAnchors` is WIRED to the cross-instance run lease.
 *
 * This is the highest-stakes wiring in the codebase. `batch-anchor.ts` SIGNS
 * AND BROADCASTS from the shared treasury, and its overlap guard was a
 * per-PROCESS `batchProcessingRunning` boolean — invisible to a second Cloud
 * Run instance, exactly like the one that let two instances drain the same
 * 10,000 public records on 2026-08-01.
 *
 * The concurrent-run damage here is worse than a duplicated drain. The claim
 * RPC is atomic, so two runs claim DISJOINT anchor cohorts — but they then
 * select from the SAME treasury UTXO set and sign two transactions spending the
 * same inputs. One is rejected as a double-spend, which drives the definitive-
 * reject unwind (refund, delete proof rows, revert the cohort to PENDING) and
 * burns the fee for nothing.
 *
 * The lease PRIMITIVE is pinned in `__tests__/run-lease.test.ts`. This file
 * pins only what that suite cannot see: that this job actually calls it, on
 * every entry path, and gives it back afterwards.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BATCH_ANCHOR_RUN_LEASE } from './run-lease.js';
import { createRunLeaseStore } from './__tests__/__testHelpers.js';

const { mockLogger, leaseStores, dbFrom, mockGetFlag, mockCallRpc } = vi.hoisted(() => {
  const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  // Reassigned per test; the db mock closes over the box, not the value.
  const leaseStores: { current: ((table: string) => unknown) | null } = { current: null };
  const mockGetFlag = vi.fn(() => true);
  const mockCallRpc = vi.fn();
  const dbFrom = vi.fn((table: string) => {
    if (table === 'job_queue' && leaseStores.current) return leaseStores.current(table);
    throw new Error(`batch drain must not read '${table}' without the run lease`);
  });
  return { mockLogger, leaseStores, dbFrom, mockGetFlag, mockCallRpc };
});

vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));

vi.mock('../config.js', () => ({
  config: {
    bitcoinNetwork: 'signet',
    nodeEnv: 'test',
    useMocks: true,
    batchAnchorMaxSize: 10_000,
  },
}));

vi.mock('../middleware/flagRegistry.js', () => ({
  flagRegistry: { getFlag: mockGetFlag },
}));

vi.mock('../utils/db.js', () => ({
  db: { from: dbFrom, rpc: mockCallRpc },
  withDbTimeout: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../chain/client.js', () => ({
  getChainClientAsync: vi.fn(async () => {
    throw new Error('batch drain must not reach the chain client without the run lease');
  }),
  getInitializedChainClient: vi.fn(),
  getChainClient: vi.fn(),
}));

vi.mock('../utils/orgCredits.js', () => ({ deductOrgCredit: vi.fn() }));
vi.mock('../utils/complianceMapping.js', () => ({ getComplianceControlIds: () => [] }));
vi.mock('../utils/anchorProofs.js', () => ({ upsertAnchorProofs: vi.fn() }));

import { processBatchAnchors } from './batch-anchor.js';

const EMPTY = { processed: 0, batchId: null, merkleRoot: null, txId: null };

describe('batch anchoring is guarded by the shared run lease', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetFlag.mockReturnValue(true);
    leaseStores.current = null;
  });

  /**
   * The load-bearing assertion. Every non-lease table read and the chain client
   * itself throw in this suite, so if the lease call were deleted the drain
   * would blow up here instead of quietly returning EMPTY.
   */
  it('signs and broadcasts nothing when another instance holds the lease', async () => {
    const held = createRunLeaseStore(BATCH_ANCHOR_RUN_LEASE, {
      held: { holder: 'other-instance', expiresAt: '2099-01-01T00:00:00Z' },
    });
    leaseStores.current = held.from;

    expect(await processBatchAnchors()).toEqual(EMPTY);
    expect(mockCallRpc).not.toHaveBeenCalled();
    expect(held.current()?.payload.holder).toBe('other-instance');
  });

  /**
   * A per-ORG run is not independent of a global one: `orgId` scopes which
   * anchors are claimed, but the treasury both runs spend from is the same. The
   * lease is therefore global, and an org run must respect it — this is the
   * path `org-queue-scheduler.ts`, `connector-artifact-drain.ts`, and the
   * manual `/queue/run` API all take.
   */
  it('refuses an org-scoped run while the global lease is held', async () => {
    const held = createRunLeaseStore(BATCH_ANCHOR_RUN_LEASE, {
      held: { holder: 'other-instance', expiresAt: '2099-01-01T00:00:00Z' },
    });
    leaseStores.current = held.from;

    expect(await processBatchAnchors({ force: true, orgId: 'org-1' })).toEqual(EMPTY);
    expect(mockCallRpc).not.toHaveBeenCalled();
  });

  /** `?force=true` bypasses the size/age deferral, never the concurrency guard. */
  it('does not let force=true bypass the lease', async () => {
    const held = createRunLeaseStore(BATCH_ANCHOR_RUN_LEASE, {
      held: { holder: 'other-instance', expiresAt: '2099-01-01T00:00:00Z' },
    });
    leaseStores.current = held.from;

    expect(await processBatchAnchors({ force: true })).toEqual(EMPTY);
    expect(mockCallRpc).not.toHaveBeenCalled();
  });

  /**
   * The flag gate is resolved BEFORE the lease: a disabled pipeline should not
   * write lease rows on every cron tick just to discover it has nothing to do.
   */
  it('does not touch the lease row when batch anchoring is flagged off', async () => {
    const store = createRunLeaseStore(BATCH_ANCHOR_RUN_LEASE, 'free');
    leaseStores.current = store.from;
    mockGetFlag.mockReturnValue(false);

    expect(await processBatchAnchors()).toEqual(EMPTY);
    expect(store.callCount()).toBe(0);
  });

  /**
   * A run that dies between broadcast and release must not strand the lease
   * beyond the TTL for lack of a `finally`. (A hard process death still leaves
   * it held until the TTL expires — that is the design, and why the TTL is
   * bounded below Cloud Run's request ceiling.)
   */
  it('releases the lease when the drain throws', async () => {
    const store = createRunLeaseStore(BATCH_ANCHOR_RUN_LEASE, 'free');
    leaseStores.current = store.from;

    await expect(processBatchAnchors()).rejects.toThrow(/without the run lease/);
    expect(store.current()?.status).toBe('completed');
    expect(store.current()?.scheduled_for).toBeNull();
  });

  /** Fail CLOSED: an unverifiable lease is not a licence to broadcast. */
  it('does not broadcast when the lease store is unreachable', async () => {
    leaseStores.current = () => {
      throw new Error('lease store unreachable');
    };

    expect(await processBatchAnchors()).toEqual(EMPTY);
    expect(mockCallRpc).not.toHaveBeenCalled();
  });
});
