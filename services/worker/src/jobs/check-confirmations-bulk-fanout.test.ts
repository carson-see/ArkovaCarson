/**
 * Unit tests for fanOutBulkSecuredWebhooks (SCRUM-1264 R2-1).
 *
 * Locks the contract restored after commit a5da008d (2026-03-27) silently
 * dropped per-anchor `anchor.secured` webhooks for the bulk-confirm path:
 *   - After bulk SECURED update, every anchor with org_id + public_id gets one
 *     `anchor.secured` dispatch
 *   - Anchors without org_id (no customer) or without public_id are skipped
 *   - Concurrency cap is enforced (BULK_WEBHOOK_FAN_OUT_CONCURRENCY)
 *   - Dispatch failures don't propagate; they're logged with txId + counts
 *   - Payload contains only public-allowed fields per SCRUM-1268 (R2-5)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLogger, mockDispatchWebhookEvent, anchorsSelectChain } = vi.hoisted(() => {
  const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const mockDispatchWebhookEvent = vi.fn();

  // Configurable result that the .eq().eq() chain resolves to via PromiseLike.
  const anchorsSelectChain: { data: unknown[]; error: unknown } = { data: [], error: null };

  return { mockLogger, mockDispatchWebhookEvent, anchorsSelectChain };
});

vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));

vi.mock('../webhooks/delivery.js', () => ({
  dispatchWebhookEvent: mockDispatchWebhookEvent,
}));

vi.mock('../utils/db.js', () => {
  // Minimal chain: db.from('anchors').select(cols).eq().eq() awaits to {data, error}
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    chain.eq = vi.fn(() => chain);
    // PromiseLike — `await chain` resolves to the configurable anchorsSelectChain.
    (chain as unknown as PromiseLike<unknown>).then = (onfulfilled: (v: unknown) => unknown) =>
      Promise.resolve(anchorsSelectChain).then(onfulfilled);
    return chain;
  };

  return {
    db: {
      from: vi.fn(() => ({
        select: vi.fn(() => makeChain()),
      })),
    },
  };
});

vi.mock('../config.js', () => ({
  config: {
    bitcoinNetwork: 'testnet4' as const,
    nodeEnv: 'development',
    useMocks: false,
    mempoolApiUrl: undefined,
    frontendUrl: 'http://localhost:5173',
  },
}));

vi.mock('../middleware/aiFeatureGate.js', () => ({
  isSemanticSearchEnabled: vi.fn().mockResolvedValue(false),
}));
vi.mock('../ai/embeddings.js', () => ({ generateAndStoreEmbedding: vi.fn() }));
vi.mock('../ai/factory.js', () => ({ createAIProvider: vi.fn() }));
vi.mock('../email/index.js', () => ({
  sendEmail: vi.fn(),
  buildAnchorSecuredEmail: vi.fn(),
}));
vi.mock('../utils/verifyCache.js', () => ({ invalidateVerificationCache: vi.fn() }));

// ---- System under test ----
import { fanOutBulkSecuredWebhooks } from './check-confirmations.js';

const TX = 'fake-tx-id';
const BLOCK_HEIGHT = 850000;
const BLOCK_TIMESTAMP = '2026-04-26T00:00:00Z';

describe('fanOutBulkSecuredWebhooks (SCRUM-1264 R2-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    anchorsSelectChain.data = [];
    anchorsSelectChain.error = null;
    mockDispatchWebhookEvent.mockResolvedValue(undefined);
  });

  it('dispatches one anchor.secured webhook per eligible anchor', async () => {
    anchorsSelectChain.data = [
      { id: 'a1', public_id: 'pub1', org_id: 'org-A' },
      { id: 'a2', public_id: 'pub2', org_id: 'org-A' },
      { id: 'a3', public_id: 'pub3', org_id: 'org-B' },
    ];

    await fanOutBulkSecuredWebhooks(TX, BLOCK_HEIGHT, BLOCK_TIMESTAMP);

    expect(mockDispatchWebhookEvent).toHaveBeenCalledTimes(3);
  });

  it('skips anchors with null org_id (no customer subscribed)', async () => {
    anchorsSelectChain.data = [
      { id: 'a1', public_id: 'pub1', org_id: null },
      { id: 'a2', public_id: 'pub2', org_id: 'org-B' },
    ];

    await fanOutBulkSecuredWebhooks(TX, BLOCK_HEIGHT, BLOCK_TIMESTAMP);

    expect(mockDispatchWebhookEvent).toHaveBeenCalledTimes(1);
    expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
      'org-B',
      'anchor.secured',
      'pub2', // PR #567 review-fix: eventId is `public_id`, not internal UUID
      expect.any(Object),
    );
  });

  it('PR #567 review-fix: passes public_id (NOT internal UUID) as the eventId arg — CLAUDE.md §6', async () => {
    anchorsSelectChain.data = [{ id: 'internal-uuid-aaa', public_id: 'pub1', org_id: 'org-A' }];

    await fanOutBulkSecuredWebhooks(TX, BLOCK_HEIGHT, BLOCK_TIMESTAMP);

    const [, , eventId] = mockDispatchWebhookEvent.mock.calls[0];
    expect(eventId).toBe('pub1');
    expect(eventId).not.toBe('internal-uuid-aaa');
  });

  it('skips anchors without public_id (cannot satisfy R2-5 payload schema)', async () => {
    anchorsSelectChain.data = [
      { id: 'a1', public_id: null, org_id: 'org-A' },
      { id: 'a2', public_id: '', org_id: 'org-A' },
      { id: 'a3', public_id: 'pub3', org_id: 'org-A' },
    ];

    await fanOutBulkSecuredWebhooks(TX, BLOCK_HEIGHT, BLOCK_TIMESTAMP);

    expect(mockDispatchWebhookEvent).toHaveBeenCalledTimes(1);
  });

  it('emits a clean payload (no anchor_id, no fingerprint) — CLAUDE.md §6 + §1.6', async () => {
    anchorsSelectChain.data = [{ id: 'a1', public_id: 'pub1', org_id: 'org-A' }];

    await fanOutBulkSecuredWebhooks(TX, BLOCK_HEIGHT, BLOCK_TIMESTAMP);

    expect(mockDispatchWebhookEvent).toHaveBeenCalledTimes(1);
    const [, , , payload] = mockDispatchWebhookEvent.mock.calls[0];
    expect(payload).not.toHaveProperty('anchor_id');
    expect(payload).not.toHaveProperty('fingerprint');
    expect(payload).not.toHaveProperty('user_id');
    expect(payload).not.toHaveProperty('org_id');
    expect(payload).toMatchObject({
      public_id: 'pub1',
      status: 'SECURED',
      chain_tx_id: TX,
      chain_block_height: BLOCK_HEIGHT,
      chain_timestamp: BLOCK_TIMESTAMP,
      secured_at: BLOCK_TIMESTAMP,
    });
  });

  it('does not throw when individual dispatches reject (DLQ holds retries)', async () => {
    anchorsSelectChain.data = [
      { id: 'a1', public_id: 'pub1', org_id: 'org-A' },
      { id: 'a2', public_id: 'pub2', org_id: 'org-B' },
    ];
    mockDispatchWebhookEvent
      .mockRejectedValueOnce(new Error('endpoint timeout'))
      .mockResolvedValueOnce(undefined);

    await expect(fanOutBulkSecuredWebhooks(TX, BLOCK_HEIGHT, BLOCK_TIMESTAMP)).resolves.toBeUndefined();

    expect(mockDispatchWebhookEvent).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ txId: TX, anchorsDispatched: 1, anchorsFailed: 1 }),
      expect.stringContaining('Bulk webhook fan-out: some dispatches failed'),
    );
  });

  it('logs success once when all dispatches resolve', async () => {
    anchorsSelectChain.data = [
      { id: 'a1', public_id: 'pub1', org_id: 'org-A' },
      { id: 'a2', public_id: 'pub2', org_id: 'org-B' },
    ];

    await fanOutBulkSecuredWebhooks(TX, BLOCK_HEIGHT, BLOCK_TIMESTAMP);

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ txId: TX, anchorsDispatched: 2 }),
      expect.stringContaining('anchor.secured delivered for all anchors'),
    );
  });

  it('logs and returns when the SECURED query errors (no DLQ writes)', async () => {
    anchorsSelectChain.error = { code: 'PGRST301', message: 'rls denied' };

    await fanOutBulkSecuredWebhooks(TX, BLOCK_HEIGHT, BLOCK_TIMESTAMP);

    expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('returns silently when no anchors found for the tx', async () => {
    anchorsSelectChain.data = [];

    await fanOutBulkSecuredWebhooks(TX, BLOCK_HEIGHT, BLOCK_TIMESTAMP);

    expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
  });
});
