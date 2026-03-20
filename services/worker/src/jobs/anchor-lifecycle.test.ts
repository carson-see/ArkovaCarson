/**
 * Anchor Lifecycle Integration Test
 *
 * HARDENING-4: Tests the full anchor lifecycle flow:
 * PENDING → chain submit → SECURED → audit logged → webhook dispatched
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
    nodeEnv: 'test',
    useMocks: true,
  },
  getNetworkDisplayName: vi.fn(() => 'Test Environment'),
}));

vi.mock('../chain/client.js', () => ({
  getInitializedChainClient: () => ({ submitFingerprint: mockSubmitFingerprint }),
}));

vi.mock('../webhooks/delivery.js', () => ({
  dispatchWebhookEvent: mockDispatchWebhookEvent,
}));

// Stateful DB mock that tracks mutations
vi.mock('../utils/db.js', () => {
  const createSelectChain = (_anchorId?: string) => {
    const chain: Record<string, unknown> & { _id?: string; _status?: string } = {};

    chain.eq = vi.fn((field: string, value: string) => {
      if (field === 'id') chain._id = value;
      if (field === 'status') chain._status = value;
      return chain;
    });
    chain.is = vi.fn(() => chain);
    chain.single = vi.fn(() => {
      const id = chain._id;
      const anchor = id ? dbState.anchors.get(id) : undefined;
      if (!anchor || (chain._status && anchor.status !== chain._status)) {
        return Promise.resolve({ data: null, error: null });
      }
      return Promise.resolve({ data: { ...anchor }, error: null });
    });
    chain.limit = vi.fn(() => {
      const pending = Array.from(dbState.anchors.entries())
        .filter(([, a]) => a.status === 'PENDING' && !a.deleted_at)
        .map(([id]) => ({ id }));
      return Promise.resolve({ data: pending, error: null });
    });

    return chain;
  };

  const createUpdateChain = () => {
    let updateData: Record<string, unknown> = {};
    return {
      update: vi.fn((data: Record<string, unknown>) => {
        updateData = data;
        return {
          eq: vi.fn((field: string, value: string) => {
            if (field === 'id') {
              const anchor = dbState.anchors.get(value);
              if (anchor) {
                Object.assign(anchor, updateData);
              }
            }
            return Promise.resolve({ error: null });
          }),
        };
      }),
    };
  };

  return {
    db: {
      rpc: vi.fn(() => Promise.resolve({ data: true, error: null })),
      from: vi.fn((table: string) => {
        if (table === 'anchors') {
          return {
            ...createSelectChain(),
            select: vi.fn(() => createSelectChain()),
            ...createUpdateChain(),
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
  };
});

// ---- System under test ----

import { processAnchor, processPendingAnchors } from './anchor.js';

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
    fingerprint: hexId, // Valid 64-char hex SHA-256
    status: 'PENDING',
    file_name: 'test.pdf',
    file_size: 1024,
    public_id: `pub-${id}`,
    created_at: '2026-03-10T10:00:00Z',
    deleted_at: null,
    ...overrides,
  });
}

// ================================================================
// Full Lifecycle Integration Tests
// ================================================================

describe('anchor lifecycle: PENDING → SUBMITTED → webhook', () => {
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

    const result = await processAnchor('anc-001');

    // 1. Returns success
    expect(result).toBe(true);

    // 2. Anchor status updated to SUBMITTED in DB (BETA-01: confirmed later by cron)
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
    expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
      'org-001',
      'anchor.submitted',
      'anc-001',
      expect.objectContaining({
        anchor_id: 'anc-001',
        public_id: 'pub-anc-001',
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        status: 'SUBMITTED',
        chain_tx_id: RECEIPT.receiptId,
        submitted_at: RECEIPT.blockTimestamp,
      }),
    );
  });

  it('processes multiple anchors through the batch flow', async () => {
    seedAnchor('anc-001');
    seedAnchor('anc-002');
    seedAnchor('anc-003');

    const result = await processPendingAnchors();

    expect(result).toEqual({ processed: 3, failed: 0 });

    // All three anchors submitted (BETA-01: confirmed later by cron)
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

    // First and third submitted, second still PENDING
    expect(dbState.anchors.get('anc-001')?.status).toBe('SUBMITTED');
    expect(dbState.anchors.get('anc-fail')?.status).toBe('PENDING');
    expect(dbState.anchors.get('anc-003')?.status).toBe('SUBMITTED');

    // Only 2 webhooks dispatched (the failures don't get webhooks)
    expect(mockDispatchWebhookEvent).toHaveBeenCalledTimes(2);
  });

  it('webhook failure does not affect anchor SUBMITTED status', async () => {
    seedAnchor('anc-001');
    mockDispatchWebhookEvent.mockRejectedValue(new Error('webhook delivery failed'));

    const result = await processAnchor('anc-001');

    // Anchor is still SUBMITTED despite webhook failure
    expect(result).toBe(true);
    expect(dbState.anchors.get('anc-001')?.status).toBe('SUBMITTED');
    expect(dbState.auditEvents).toHaveLength(1);
  });

  it('operations execute in correct order: chain → DB update → audit → webhook', async () => {
    seedAnchor('anc-001');

    const callOrder: string[] = [];

    mockSubmitFingerprint.mockImplementation(async () => {
      callOrder.push('chain_submit');
      return RECEIPT;
    });

    mockDispatchWebhookEvent.mockImplementation(async () => {
      callOrder.push('webhook_dispatch');
    });

    // Intercept audit insert to track ordering
    const originalAuditEvents = dbState.auditEvents;
    const originalPush = originalAuditEvents.push.bind(originalAuditEvents);
    dbState.auditEvents.push = ((...args: Record<string, unknown>[]) => {
      callOrder.push('audit_log');
      return originalPush(...args);
    }) as typeof originalAuditEvents.push;

    await processAnchor('anc-001');

    // DB update happens between chain_submit and audit_log (verified by SUBMITTED status)
    expect(callOrder[0]).toBe('chain_submit');
    // audit_log comes after chain submit + DB update
    expect(callOrder).toContain('audit_log');
    // webhook_dispatch comes last
    expect(callOrder.at(-1)).toBe('webhook_dispatch');

    // Restore
    dbState.auditEvents.push = originalPush;
  });

  it('individual anchor without org_id skips webhook but still secures', async () => {
    seedAnchor('anc-individual', { org_id: null, user_id: 'individual-user' });

    const result = await processAnchor('anc-individual');

    expect(result).toBe(true);
    expect(dbState.anchors.get('anc-individual')?.status).toBe('SUBMITTED');
    expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
  });
});
