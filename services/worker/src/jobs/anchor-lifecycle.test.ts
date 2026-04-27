/**
 * Anchor Lifecycle Integration Test
 *
 * HARDENING-4: Tests the full anchor lifecycle flow:
 * PENDING → (claim) → BROADCASTING → chain submit → SUBMITTED → audit logged → webhook dispatched
 *
 * This is a higher-level integration test that verifies the components
 * work together correctly, complementing the unit tests in anchor.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChainReceipt } from '../chain/types.js';

// ---- Hoisted mocks ----

const {
  mockSubmitFingerprint,
  mockDispatchWebhookEvent,
  mockLogger,
  dbState,
} = vi.hoisted(() => {
  const mockSubmitFingerprint = vi.fn();
  const mockDispatchWebhookEvent = vi.fn();
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  // Simulated DB state for lifecycle tracking
  const dbState = {
    anchors: new Map<string, Record<string, unknown>>(),
    auditEvents: [] as Record<string, unknown>[],
  };

  return { mockSubmitFingerprint, mockDispatchWebhookEvent, mockLogger, dbState };
});

// ---- Module mocks ----

vi.mock('../utils/logger.js', () => ({
  logger: mockLogger,
  createRpcLogger: vi.fn(() => ({
    start: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../config.js', () => ({
  config: {
    chainNetwork: 'testnet' as const,
    bitcoinNetwork: 'testnet' as const,
    nodeEnv: 'test',
    useMocks: true,
  },
  getNetworkDisplayName: vi.fn(() => 'Test Environment'),
}));

vi.mock('../chain/client.js', () => ({
  getInitializedChainClient: () => ({ submitFingerprint: mockSubmitFingerprint }),
  getChainClientAsync: () => Promise.resolve({ submitFingerprint: mockSubmitFingerprint }),
}));

vi.mock('../webhooks/delivery.js', () => ({
  dispatchWebhookEvent: mockDispatchWebhookEvent,
}));

// Mock billing modules added by M2M payments audit
vi.mock('../billing/paymentGuard.js', () => ({
  checkPaymentGuard: vi.fn().mockResolvedValue({
    authorized: true,
    source: { id: 'beta_override', type: 'beta_unlimited' },
  }),
}));

vi.mock('../billing/reconciliation.js', () => ({
  isFreeTierUser: vi.fn().mockResolvedValue(false),
  isWithinBatchWindow: vi.fn().mockReturnValue(true),
}));

// Stateful DB mock that tracks mutations
vi.mock('../utils/db.js', () => {
  const createUpdateChain = () => {
    let updateData: Record<string, unknown> = {};
    return {
      update: vi.fn((data: Record<string, unknown>) => {
        updateData = data;
        const chain: Record<string, unknown> = {};
        chain.eq = vi.fn((field: string, value: string) => {
          if (field === 'id') {
            const anchor = dbState.anchors.get(value);
            if (anchor) {
              Object.assign(anchor, updateData);
            }
          }
          return chain;
        });
        chain.is = vi.fn(() => chain);
        chain.then = (resolve: (v: unknown) => void) => resolve({ error: null, count: 1 });
        return chain;
      }),
    };
  };

  return {
    db: {
      rpc: vi.fn((fnName: string) => {
        if (fnName === 'get_flag') return Promise.resolve({ data: true, error: null });
        if (fnName === 'claim_pending_anchors') {
          // Return PENDING anchors as claimed
          const pending = Array.from(dbState.anchors.entries())
            .filter(([, a]) => a.status === 'PENDING' && !a.deleted_at && !(a.metadata as Record<string, unknown> | null)?.pipeline_source)
            .map(([id, a]) => {
              // Mark as BROADCASTING in state
              a.status = 'BROADCASTING';
              return {
                id,
                user_id: a.user_id,
                org_id: a.org_id,
                fingerprint: a.fingerprint,
                public_id: a.public_id,
                metadata: a.metadata,
                credential_type: a.credential_type ?? null,
              };
            });
          return Promise.resolve({ data: pending, error: null });
        }
        return Promise.resolve({ data: null, error: { message: 'RPC not in cache' } });
      }),
      from: vi.fn((table: string) => {
        if (table === 'anchors') {
          return {
            ...createUpdateChain(),
            select: vi.fn(() => {
              const chain: Record<string, unknown> = {};
              chain.eq = vi.fn(() => chain);
              chain.is = vi.fn(() => chain);
              chain.order = vi.fn(() => chain);
              chain.limit = vi.fn(() => Promise.resolve({ data: [], error: null }));
              chain.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
              return chain;
            }),
          };
        }
        if (table === 'audit_events') {
          return {
            insert: vi.fn((event: Record<string, unknown>) => {
              dbState.auditEvents.push(event);
              return Promise.resolve({ error: null });
            }),
          };
        }
        if (table === 'anchor_chain_index') {
          return {
            upsert: vi.fn(() => Promise.resolve({ error: null })),
          };
        }
        return {};
      }),
    },
    // Pass-through in tests — no actual timeout
    withDbTimeout: vi.fn((fn: () => Promise<unknown>) => fn()),
  };
});

// ---- System under test ----

import { processAnchor, processPendingAnchors } from './anchor.js';
import type { ClaimedAnchor } from './anchor.js';

// ---- Test fixtures ----

const RECEIPT: ChainReceipt = {
  receiptId: 'receipt_lifecycle_001',
  blockHeight: 850000,
  blockTimestamp: '2026-03-10T12:00:00Z',
  confirmations: 6,
};

/** Counter for generating unique but valid 64-char hex fingerprints */
let fingerprintCounter = 0;

function seedAnchor(id: string, overrides: Record<string, unknown> = {}) {
  fingerprintCounter++;
  const hexId = fingerprintCounter.toString(16).padStart(64, '0');
  dbState.anchors.set(id, {
    id,
    user_id: 'user-001',
    org_id: 'org-001',
    fingerprint: hexId,
    status: 'PENDING',
    file_name: 'test.pdf',
    file_size: 1024,
    public_id: `pub-${id}`,
    created_at: '2026-03-10T10:00:00Z',
    deleted_at: null,
    credential_type: null,
    ...overrides,
  });
}

function makeClaimedAnchor(id: string): ClaimedAnchor {
  const anchor = dbState.anchors.get(id)!;
  return {
    id,
    user_id: anchor.user_id as string,
    org_id: anchor.org_id as string | null,
    fingerprint: anchor.fingerprint as string,
    public_id: anchor.public_id as string | null,
    metadata: anchor.metadata as Record<string, unknown> | null ?? null,
    credential_type: anchor.credential_type as string | null ?? null,
  };
}

// ================================================================
// Full Lifecycle Integration Tests
// ================================================================

describe('anchor lifecycle: PENDING → BROADCASTING → SUBMITTED → webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.anchors.clear();
    dbState.auditEvents = [];
    fingerprintCounter = 0;
    mockSubmitFingerprint.mockResolvedValue(RECEIPT);
    mockDispatchWebhookEvent.mockResolvedValue(undefined);
  });

  it('processes a single anchor through the full lifecycle', async () => {
    seedAnchor('anc-001');
    // Simulate claim: PENDING → BROADCASTING
    dbState.anchors.get('anc-001')!.status = 'BROADCASTING';

    const result = await processAnchor(makeClaimedAnchor('anc-001'));

    // 1. Returns success
    expect(result).toBe(true);

    // 2. Anchor status updated to SUBMITTED in DB
    const anchor = dbState.anchors.get('anc-001');
    expect(anchor?.status).toBe('SUBMITTED');
    expect(anchor?.chain_tx_id).toBe(RECEIPT.receiptId);
    expect(anchor?.chain_block_height).toBe(RECEIPT.blockHeight);

    // 3. Audit event logged
    expect(dbState.auditEvents).toHaveLength(1);
    expect(dbState.auditEvents[0]).toMatchObject({
      event_type: 'anchor.submitted',
      event_category: 'ANCHOR',
      actor_id: 'user-001',
      target_id: 'anc-001',
      org_id: 'org-001',
    });

    // 4. Webhook dispatched with correct payload
    expect(mockDispatchWebhookEvent).toHaveBeenCalledOnce();
    // SCRUM-1268 (R2-5): event_id is public_id; payload obeys strict
    // AnchorSubmitted schema (no anchor_id / fingerprint).
    expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
      'org-001',
      'anchor.submitted',
      'pub-anc-001',
      expect.objectContaining({
        public_id: 'pub-anc-001',
        status: 'SUBMITTED',
        chain_tx_id: RECEIPT.receiptId,
        submitted_at: RECEIPT.blockTimestamp,
      }),
    );
  });

  it('processes multiple anchors through the claim-then-broadcast flow', async () => {
    seedAnchor('anc-001');
    seedAnchor('anc-002');
    seedAnchor('anc-003');

    const result = await processPendingAnchors();

    expect(result).toEqual({ processed: 3, failed: 0 });

    // All three anchors submitted
    expect(dbState.anchors.get('anc-001')?.status).toBe('SUBMITTED');
    expect(dbState.anchors.get('anc-002')?.status).toBe('SUBMITTED');
    expect(dbState.anchors.get('anc-003')?.status).toBe('SUBMITTED');

    // All three audit events logged
    expect(dbState.auditEvents).toHaveLength(3);

    // All three webhooks dispatched
    expect(mockDispatchWebhookEvent).toHaveBeenCalledTimes(3);
  });

  it('does not process already-SECURED anchors', async () => {
    seedAnchor('anc-secured', { status: 'SECURED' });

    const result = await processPendingAnchors();

    // No PENDING anchors found
    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(mockSubmitFingerprint).not.toHaveBeenCalled();
    expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it('skips soft-deleted anchors in batch processing', async () => {
    seedAnchor('anc-live');
    seedAnchor('anc-deleted', { deleted_at: '2026-03-10T11:00:00Z' });

    const result = await processPendingAnchors();

    // Only the live anchor should be processed
    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(dbState.anchors.get('anc-live')?.status).toBe('SUBMITTED');
    expect(dbState.anchors.get('anc-deleted')?.status).toBe('PENDING');
  });

  it('isolates failures: one chain failure does not block others', async () => {
    seedAnchor('anc-001');
    seedAnchor('anc-fail');
    seedAnchor('anc-003');

    // Fail on second call only
    mockSubmitFingerprint
      .mockResolvedValueOnce(RECEIPT)
      .mockRejectedValueOnce(new Error('chain timeout'))
      .mockResolvedValueOnce(RECEIPT);

    const result = await processPendingAnchors();

    expect(result).toEqual({ processed: 2, failed: 1 });

    // First and third submitted, second reverted to PENDING
    expect(dbState.anchors.get('anc-001')?.status).toBe('SUBMITTED');
    expect(dbState.anchors.get('anc-fail')?.status).toBe('PENDING');
    expect(dbState.anchors.get('anc-003')?.status).toBe('SUBMITTED');

    // Only 2 webhooks dispatched
    expect(mockDispatchWebhookEvent).toHaveBeenCalledTimes(2);
  });

  it('webhook failure does not affect anchor SUBMITTED status', async () => {
    seedAnchor('anc-001');
    dbState.anchors.get('anc-001')!.status = 'BROADCASTING';
    mockDispatchWebhookEvent.mockRejectedValue(new Error('webhook delivery failed'));

    const result = await processAnchor(makeClaimedAnchor('anc-001'));

    // Anchor is still SUBMITTED despite webhook failure
    expect(result).toBe(true);
    expect(dbState.anchors.get('anc-001')?.status).toBe('SUBMITTED');
    expect(dbState.auditEvents).toHaveLength(1);
  });

  it('individual anchor without org_id skips webhook but still submits', async () => {
    seedAnchor('anc-individual', { org_id: null, user_id: 'individual-user' });
    dbState.anchors.get('anc-individual')!.status = 'BROADCASTING';

    const result = await processAnchor(makeClaimedAnchor('anc-individual'));

    expect(result).toBe(true);
    expect(dbState.anchors.get('anc-individual')?.status).toBe('SUBMITTED');
    expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it('reverts to PENDING on chain broadcast failure', async () => {
    seedAnchor('anc-fail');
    dbState.anchors.get('anc-fail')!.status = 'BROADCASTING';
    mockSubmitFingerprint.mockRejectedValue(new Error('network error'));

    const result = await processAnchor(makeClaimedAnchor('anc-fail'));

    expect(result).toBe(false);
    expect(dbState.anchors.get('anc-fail')?.status).toBe('PENDING');
  });

  it('reverts to PENDING when chain returns empty receipt', async () => {
    seedAnchor('anc-empty');
    dbState.anchors.get('anc-empty')!.status = 'BROADCASTING';
    mockSubmitFingerprint.mockResolvedValue({ receiptId: null });

    const result = await processAnchor(makeClaimedAnchor('anc-empty'));

    expect(result).toBe(false);
    expect(dbState.anchors.get('anc-empty')?.status).toBe('PENDING');
  });
});
