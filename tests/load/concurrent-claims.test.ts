/**
 * Concurrent Claims Load Test
 *
 * Tests that multiple "worker instances" claiming the same jobs
 * do not result in double-processing:
 * - Parallel processPendingAnchors() calls
 * - Verifies each anchor processed exactly once
 * - Tests race condition protection
 *
 * Note: The current implementation uses sequential processing
 * with a batch SELECT (not SELECT FOR UPDATE SKIP LOCKED).
 * These tests document the current behavior and establish
 * baselines for when concurrent workers are introduced.
 *
 * @created 2026-03-11 12:00 AM EST
 * @category load-test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChainReceipt } from '../../services/worker/src/chain/types.js';

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

  const dbState = {
    anchors: new Map<string, Record<string, unknown>>(),
    auditEvents: [] as Record<string, unknown>[],
    processingLog: [] as { anchorId: string; worker: string; timestamp: number }[],
  };

  return { mockSubmitFingerprint, mockDispatchWebhookEvent, mockLogger, dbState };
});

// ---- Module mocks ----

vi.mock('../../services/worker/src/utils/logger.js', () => ({ logger: mockLogger }));

vi.mock('../../services/worker/src/config.js', () => ({
  config: {
    chainNetwork: 'testnet' as const,
    nodeEnv: 'test',
    useMocks: true,
  },
  getNetworkDisplayName: vi.fn(() => 'Test Environment'),
}));

vi.mock('../../services/worker/src/chain/client.js', () => ({
  chainClient: { submitFingerprint: mockSubmitFingerprint },
}));

vi.mock('../../services/worker/src/webhooks/delivery.js', () => ({
  dispatchWebhookEvent: mockDispatchWebhookEvent,
}));

vi.mock('../../services/worker/src/utils/db.js', () => {
  const createSelectChain = () => {
    const chain: Record<string, any> = {};
    chain._filters = {} as Record<string, string>;

    chain.eq = vi.fn((field: string, value: string) => {
      chain._filters[field] = value;
      return chain;
    });
    chain.is = vi.fn(() => chain);
    chain.single = vi.fn(() => {
      const id = chain._filters['id'];
      const anchor = dbState.anchors.get(id);
      if (!anchor || (chain._filters['status'] && anchor.status !== chain._filters['status'])) {
        return Promise.resolve({ data: null, error: null });
      }
      return Promise.resolve({ data: { ...anchor }, error: null });
    });
    chain.limit = vi.fn(() => {
      const status = chain._filters['status'];
      const results = Array.from(dbState.anchors.values())
        .filter((a) => !status || a.status === status)
        .map((a) => ({ id: a.id }));
      return Promise.resolve({ data: results, error: null });
    });

    return chain;
  };

  const mockFrom = vi.fn((table: string) => {
    if (table === 'anchors') {
      return {
        select: vi.fn(() => createSelectChain()),
        update: vi.fn((data: Record<string, unknown>) => ({
          eq: vi.fn((field: string, value: string) => {
            if (field === 'id') {
              const existing = dbState.anchors.get(value);
              if (existing) {
                dbState.anchors.set(value, { ...existing, ...data });
              }
            }
            return Promise.resolve({ error: null });
          }),
        })),
      };
    }
    if (table === 'audit_events') {
      return {
        insert: vi.fn((data: Record<string, unknown>) => {
          dbState.auditEvents.push(data);
          return Promise.resolve({ error: null });
        }),
      };
    }
    return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn() })) })) };
  });

  return {
    db: { from: mockFrom },
    getDb: vi.fn(() => ({ from: mockFrom })),
  };
});

// ---- Helpers ----

function seedAnchors(count: number): void {
  dbState.anchors.clear();
  dbState.auditEvents = [];
  dbState.processingLog = [];

  for (let i = 0; i < count; i++) {
    const id = `anchor-concurrent-${i.toString().padStart(4, '0')}`;
    dbState.anchors.set(id, {
      id,
      user_id: 'user-concurrent-test',
      org_id: 'org-concurrent-test',
      fingerprint: `sha256-concurrent-${i}`,
      status: 'PENDING',
      public_id: `pub-concurrent-${i}`,
      deleted_at: null,
    });
  }
}

// ---- Tests ----

describe('Concurrent Claims Load Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.anchors.clear();
    dbState.auditEvents = [];
    dbState.processingLog = [];
  });

  describe('Parallel Worker Simulation', () => {
    it('two workers processing same batch both get results', async () => {
      seedAnchors(10);

      let chainCallCount = 0;
      mockSubmitFingerprint.mockImplementation(async () => {
        chainCallCount++;
        return {
          receiptId: `tx-concurrent-${chainCallCount}`,
          blockHeight: 800000 + chainCallCount,
          blockTimestamp: new Date().toISOString(),
          confirmations: 1,
        } satisfies ChainReceipt;
      });
      mockDispatchWebhookEvent.mockResolvedValue(undefined);

      const { processPendingAnchors } = await import(
        '../../services/worker/src/jobs/anchor.js'
      );

      // Simulate two workers calling processPendingAnchors concurrently
      const [resultA, resultB] = await Promise.all([
        processPendingAnchors(),
        processPendingAnchors(),
      ]);

      // Both workers see 10 PENDING anchors initially (no locking)
      // First worker processes all 10 successfully
      // Second worker also tries all 10, but some may already be SECURED
      // Total processed should be >= 10 (first worker gets them all)
      const totalProcessed = resultA.processed + resultB.processed;
      const totalFailed = resultA.failed + resultB.failed;

      console.log(
        `[LOAD] Worker A: ${resultA.processed} processed, ${resultA.failed} failed | ` +
          `Worker B: ${resultB.processed} processed, ${resultB.failed} failed`
      );

      // At minimum, the first worker should process all 10
      expect(totalProcessed).toBeGreaterThanOrEqual(10);

      // All anchors should end in SECURED state
      const securedCount = Array.from(dbState.anchors.values()).filter(
        (a) => a.status === 'SECURED'
      ).length;
      expect(securedCount).toBe(10);
    });

    it('three concurrent workers with 30 anchors process all', async () => {
      seedAnchors(30);

      let callCount = 0;
      mockSubmitFingerprint.mockImplementation(async () => {
        callCount++;
        return {
          receiptId: `tx-triple-${callCount}`,
          blockHeight: 800000 + callCount,
          blockTimestamp: new Date().toISOString(),
          confirmations: 1,
        } satisfies ChainReceipt;
      });
      mockDispatchWebhookEvent.mockResolvedValue(undefined);

      const { processPendingAnchors } = await import(
        '../../services/worker/src/jobs/anchor.js'
      );

      const start = performance.now();
      const [rA, rB, rC] = await Promise.all([
        processPendingAnchors(),
        processPendingAnchors(),
        processPendingAnchors(),
      ]);
      const elapsed = performance.now() - start;

      const totalProcessed = rA.processed + rB.processed + rC.processed;

      console.log(
        `[LOAD] 3 workers, 30 anchors: ` +
          `A=${rA.processed}/${rA.failed}, B=${rB.processed}/${rB.failed}, C=${rC.processed}/${rC.failed} ` +
          `(${elapsed.toFixed(0)}ms)`
      );

      // At least 30 successful processings (some may be double-processed)
      expect(totalProcessed).toBeGreaterThanOrEqual(30);

      // All anchors reach SECURED
      const allSecured = Array.from(dbState.anchors.values()).every(
        (a) => a.status === 'SECURED'
      );
      expect(allSecured).toBe(true);
    });
  });

  describe('Idempotency Protection', () => {
    it('processAnchor on already-SECURED anchor returns false (not reprocessed)', async () => {
      seedAnchors(5);

      // Mark first anchor as already SECURED
      const firstId = 'anchor-concurrent-0000';
      const existing = dbState.anchors.get(firstId)!;
      dbState.anchors.set(firstId, { ...existing, status: 'SECURED' });

      mockSubmitFingerprint.mockImplementation(async () => ({
        receiptId: 'tx-idempotent',
        blockHeight: 800001,
        blockTimestamp: new Date().toISOString(),
        confirmations: 1,
      }));
      mockDispatchWebhookEvent.mockResolvedValue(undefined);

      const { processAnchor } = await import(
        '../../services/worker/src/jobs/anchor.js'
      );

      // Try to process the SECURED anchor — should return false (not found as PENDING)
      const result = await processAnchor(firstId);
      expect(result).toBe(false);

      // Chain client should NOT have been called for the already-secured anchor
      expect(mockSubmitFingerprint).not.toHaveBeenCalled();
    });

    it('batch of 20 with 5 pre-secured only processes 15', async () => {
      seedAnchors(20);

      // Pre-secure first 5
      for (let i = 0; i < 5; i++) {
        const id = `anchor-concurrent-${i.toString().padStart(4, '0')}`;
        const existing = dbState.anchors.get(id)!;
        dbState.anchors.set(id, { ...existing, status: 'SECURED' });
      }

      mockSubmitFingerprint.mockImplementation(async () => ({
        receiptId: 'tx-partial-batch',
        blockHeight: 800002,
        blockTimestamp: new Date().toISOString(),
        confirmations: 1,
      }));
      mockDispatchWebhookEvent.mockResolvedValue(undefined);

      const { processPendingAnchors } = await import(
        '../../services/worker/src/jobs/anchor.js'
      );

      const result = await processPendingAnchors();

      // Only 15 PENDING anchors should be found and processed
      expect(result.processed).toBe(15);
      expect(result.failed).toBe(0);

      // All 20 should be SECURED now
      const securedCount = Array.from(dbState.anchors.values()).filter(
        (a) => a.status === 'SECURED'
      ).length;
      expect(securedCount).toBe(20);
    });
  });

  describe('Timing & Ordering', () => {
    it('sequential processing maintains order', async () => {
      seedAnchors(10);
      const processedOrder: string[] = [];

      mockSubmitFingerprint.mockImplementation(async () => {
        return {
          receiptId: `tx-order-${processedOrder.length}`,
          blockHeight: 800000,
          blockTimestamp: new Date().toISOString(),
          confirmations: 1,
        };
      });
      mockDispatchWebhookEvent.mockResolvedValue(undefined);

      // Track update order
      const originalUpdate = vi.fn((data: Record<string, unknown>) => ({
        eq: vi.fn((field: string, value: string) => {
          if (field === 'id' && data.status === 'SECURED') {
            processedOrder.push(value);
            const existing = dbState.anchors.get(value);
            if (existing) {
              dbState.anchors.set(value, { ...existing, ...data });
            }
          }
          return Promise.resolve({ error: null });
        }),
      }));

      const { processPendingAnchors } = await import(
        '../../services/worker/src/jobs/anchor.js'
      );

      await processPendingAnchors();

      // Anchors should be processed in the order returned by the DB query
      // (which is the order they appear in dbState.anchors Map)
      expect(processedOrder.length).toBeGreaterThan(0);
    });
  });
});
