/**
 * SCRUM-3031: `checkSubmittedConfirmations` is WIRED to the cross-instance run
 * lease.
 *
 * This job carried the same per-PROCESS `confirmationCheckRunning` boolean as
 * the two anchoring jobs, with the same cross-instance blind spot. It does not
 * sign or spend, so the concurrency damage is milder than `batch-anchor.ts` —
 * duplicated mempool reads and duplicated (idempotent) drain RPCs — with one
 * sharp exception, which is why PR #753's audit fix A3 exists: in MOCK mode two
 * concurrent runs each mint a distinct `txId = mock-batch-${Date.now()}` and
 * race the `chain_tx_id` backfill, so the loser's webhook payload carries a
 * tx_id that does not match the database.
 *
 * A3's property was that the guard wraps BOTH the mock and real arms, not one
 * of them. That is the specific thing this file pins, alongside the wiring the
 * lease primitive's own suite (`__tests__/run-lease.test.ts`) cannot see.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CHECK_CONFIRMATIONS_RUN_LEASE } from './run-lease.js';
import { createRunLeaseStore } from './__tests__/__testHelpers.js';

const { mockLogger, leaseStores, dbFrom, mockRpc, mockConfig } = vi.hoisted(() => {
  const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const leaseStores: { current: ((table: string) => unknown) | null } = { current: null };
  const mockRpc = vi.fn();
  const mockConfig = {
    bitcoinNetwork: 'signet' as string,
    nodeEnv: 'test' as string,
    useMocks: true,
    mempoolApiUrl: undefined as string | undefined,
    frontendUrl: 'http://localhost:5173',
  };
  const dbFrom = vi.fn((table: string) => {
    if (table === 'job_queue' && leaseStores.current) return leaseStores.current(table);
    throw new Error(`confirmation check must not read '${table}' without the run lease`);
  });
  return { mockLogger, leaseStores, dbFrom, mockRpc, mockConfig };
});

vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../config.js', () => ({ config: mockConfig }));
vi.mock('../utils/db.js', () => ({ db: { from: dbFrom, rpc: mockRpc } }));
vi.mock('../utils/verifyCache.js', () => ({ invalidateVerificationCache: vi.fn() }));
// `utils/sentry.js` initializes the real @sentry/node SDK at import time. This
// suite never reaches the tip-height alert path, and loading the SDK to prove
// a lease is held is both pointless and (on a workspace without the optional
// native profiling dep installed) an import-time hard failure that hides every
// assertion in this file behind an unrelated error. Mocked, as in
// check-confirmations.test.ts.
vi.mock('../utils/sentry.js', () => ({ captureConfirmationTipHeightUnavailable: vi.fn() }));
vi.mock('../webhooks/delivery.js', () => ({ dispatchWebhookEvent: vi.fn() }));
vi.mock('../email/index.js', () => ({ sendEmail: vi.fn(), buildAnchorSecuredEmail: vi.fn() }));
vi.mock('../ai/embeddings.js', () => ({ generateAndStoreEmbedding: vi.fn() }));
vi.mock('../ai/factory.js', () => ({ createAIProvider: vi.fn() }));
vi.mock('../middleware/aiFeatureGate.js', () => ({
  isSemanticSearchEnabled: vi.fn().mockResolvedValue(false),
}));

import { checkSubmittedConfirmations } from './check-confirmations.js';

/**
 * F-D0-2 (fullsoak 2026-08-12): a lease-blocked run must be DISTINGUISHABLE
 * from an empty one. During the F-D0-5 incident, 31 forced POSTs over 29
 * minutes all returned the identical `{"checked":0,"confirmed":0}` body while
 * promotion was silently disabled — operators could not tell "nothing to do"
 * from "blocked behind a hung holder". `skipped` carries that signal.
 */
const LEASE_BLOCKED = { checked: 0, confirmed: 0, skipped: 'run-lease-held' };

function heldLease() {
  return createRunLeaseStore(CHECK_CONFIRMATIONS_RUN_LEASE, {
    held: { holder: 'other-instance', expiresAt: '2099-01-01T00:00:00Z' },
  });
}

describe('confirmation check is guarded by the shared run lease', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    leaseStores.current = null;
    mockConfig.useMocks = true;
    mockConfig.nodeEnv = 'test';
  });

  it('reads no anchors when another instance holds the lease', async () => {
    const held = heldLease();
    leaseStores.current = held.from;

    expect(await checkSubmittedConfirmations()).toEqual(LEASE_BLOCKED);
    expect(held.current()?.payload.holder).toBe('other-instance');
  });

  /**
   * PR #753 audit fix A3, preserved. The mock-mode arm used to return before
   * the guard was taken; two concurrent runs then minted distinct
   * `mock-batch-${Date.now()}` tx ids and raced the chain_tx_id backfill. The
   * lease must wrap the BRANCH, not the real-mode arm of it.
   */
  it('covers the mock-mode arm too, not just the real-mode one', async () => {
    const held = heldLease();
    leaseStores.current = held.from;
    mockConfig.useMocks = true;

    expect(await checkSubmittedConfirmations()).toEqual(LEASE_BLOCKED);
    // `autoConfirmMockAnchors` reads `anchors` first, and that read throws in
    // this suite — so reaching it at all would fail loudly rather than silently.
    expect(dbFrom).not.toHaveBeenCalledWith('anchors');
  });

  it('covers the real-mode arm', async () => {
    const held = heldLease();
    leaseStores.current = held.from;
    mockConfig.useMocks = false;
    mockConfig.nodeEnv = 'production';

    expect(await checkSubmittedConfirmations()).toEqual(LEASE_BLOCKED);
    expect(dbFrom).not.toHaveBeenCalledWith('anchors');
  });

  /** RACE-3, restated: the guard comes back even when the run throws. */
  it('releases the lease when the run throws', async () => {
    const store = createRunLeaseStore(CHECK_CONFIRMATIONS_RUN_LEASE, 'free');
    leaseStores.current = store.from;

    await expect(checkSubmittedConfirmations()).rejects.toThrow(/without the run lease/);
    expect(store.current()?.status).toBe('completed');
    expect(store.current()?.scheduled_for).toBeNull();
  });

  /** Fail CLOSED on an unverifiable lease. */
  it('does nothing when the lease store is unreachable', async () => {
    leaseStores.current = () => {
      throw new Error('lease store unreachable');
    };

    expect(await checkSubmittedConfirmations()).toEqual(LEASE_BLOCKED);
    expect(dbFrom).not.toHaveBeenCalledWith('anchors');
  });
});
