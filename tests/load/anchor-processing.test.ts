/**
 * Anchor Processing Load Test
 *
 * Stress-tests processAnchor() and processPendingAnchors() with high volume:
 * - 100+ PENDING anchors processed sequentially
 * - Throughput measurement (anchors/second)
 * - Verifies all anchors reach SECURED state
 * - Measures degradation under load
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
    processedIds: [] as string[],
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

// Stateful DB mock that tracks mutations across many anchors
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
                dbState.processedIds.push(value);
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
  dbState.processedIds = [];

  for (let i = 0; i < count; i++) {
    const id = `anchor-load-${i.toString().padStart(4, '0')}`;
    dbState.anchors.set(id, {
      id,
      user_id: 'user-load-test',
      org_id: 'org-load-test',
      fingerprint: `sha256-load-${i}`,
      status: 'PENDING',
      public_id: `pub-load-${i}`,
      deleted_at: null,
    });
  }
}

function makeReceipt(anchorId: string): ChainReceipt {
  return {
    receiptId: `tx-${anchorId}`,
    blockHeight: 800000 + Math.floor(Math.random() * 1000),
    blockTimestamp: new Date().toISOString(),
    confirmations: 1,
  };
}

// ---- Tests ----

describe('Anchor Processing Load Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.anchors.clear();
    dbState.auditEvents = [];
    dbState.processedIds = [];
  });

  describe('Throughput', () => {
    it('processes 100 PENDING anchors to SECURED', async () => {
      const ANCHOR_COUNT = 100;
      seedAnchors(ANCHOR_COUNT);

      mockSubmitFingerprint.mockImplementation(async () => {
        return makeReceipt('batch');
      });
      mockDispatchWebhookEvent.mockResolvedValue(undefined);

      const { processPendingAnchors } = await import(
        '../../services/worker/src/jobs/anchor.js'
      );

      const start = performance.now();
      const result = await processPendingAnchors();
      const elapsed = performance.now() - start;

      const throughput = (result.processed / (elapsed / 1000)).toFixed(1);

      // All 100 anchors should be processed (limit is 100)
      expect(result.processed).toBe(ANCHOR_COUNT);
      expect(result.failed).toBe(0);

      // Verify all reached SECURED in DB state
      const securedCount = Array.from(dbState.anchors.values()).filter(
        (a) => a.status === 'SECURED'
      ).length;
      expect(securedCount).toBe(ANCHOR_COUNT);

      // Audit events logged for each
      expect(dbState.auditEvents.length).toBe(ANCHOR_COUNT);

      // Log throughput for baseline tracking
      console.log(
        `[LOAD] Processed ${result.processed} anchors in ${elapsed.toFixed(0)}ms ` +
          `(${throughput} anchors/sec)`
      );

      // Throughput threshold: should process 100 anchors in under 5 seconds
      // (generous — mocked chain calls are instant)
      expect(elapsed).toBeLessThan(5000);
    });

    it('processes 50 anchors individually and measures per-anchor time', async () => {
      const ANCHOR_COUNT = 50;
      seedAnchors(ANCHOR_COUNT);

      mockSubmitFingerprint.mockImplementation(async () => makeReceipt('individual'));
      mockDispatchWebhookEvent.mockResolvedValue(undefined);

      const { processAnchor } = await import(
        '../../services/worker/src/jobs/anchor.js'
      );

      const timings: number[] = [];

      for (let i = 0; i < ANCHOR_COUNT; i++) {
        const id = `anchor-load-${i.toString().padStart(4, '0')}`;
        const start = performance.now();
        const success = await processAnchor(id);
        const elapsed = performance.now() - start;

        expect(success).toBe(true);
        timings.push(elapsed);
      }

      const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
      const max = Math.max(...timings);
      const sorted = [...timings].sort((a, b) => a - b);
      const p95 = sorted[Math.floor(sorted.length * 0.95)];

      console.log(
        `[LOAD] Per-anchor timing (${ANCHOR_COUNT} anchors): ` +
          `avg=${avg.toFixed(1)}ms, p95=${p95.toFixed(1)}ms, max=${max.toFixed(1)}ms`
      );

      // Average should be well under 100ms with mocked chain
      expect(avg).toBeLessThan(100);
    });
  });

  describe('Failure Isolation', () => {
    it('partial chain failures do not block remaining anchors', async () => {
      const ANCHOR_COUNT = 20;
      seedAnchors(ANCHOR_COUNT);

      // Every 5th anchor fails on chain submission
      let callCount = 0;
      mockSubmitFingerprint.mockImplementation(async () => {
        callCount++;
        if (callCount % 5 === 0) {
          throw new Error('Chain timeout (simulated)');
        }
        return makeReceipt(`call-${callCount}`);
      });
      mockDispatchWebhookEvent.mockResolvedValue(undefined);

      const { processPendingAnchors } = await import(
        '../../services/worker/src/jobs/anchor.js'
      );

      const result = await processPendingAnchors();

      // 4 out of every 5 succeed
      expect(result.processed).toBe(16);
      expect(result.failed).toBe(4);

      // Failed anchors should still be PENDING (not corrupted)
      const pendingAnchors = Array.from(dbState.anchors.values()).filter(
        (a) => a.status === 'PENDING'
      );
      expect(pendingAnchors.length).toBe(4);
    });

    it('handles all anchors failing without crashing', async () => {
      const ANCHOR_COUNT = 10;
      seedAnchors(ANCHOR_COUNT);

      mockSubmitFingerprint.mockRejectedValue(new Error('Chain completely down'));
      mockDispatchWebhookEvent.mockResolvedValue(undefined);

      const { processPendingAnchors } = await import(
        '../../services/worker/src/jobs/anchor.js'
      );

      const result = await processPendingAnchors();

      expect(result.processed).toBe(0);
      expect(result.failed).toBe(ANCHOR_COUNT);

      // All anchors remain PENDING
      const allPending = Array.from(dbState.anchors.values()).every(
        (a) => a.status === 'PENDING'
      );
      expect(allPending).toBe(true);
    });
  });

  describe('Chain Latency Simulation', () => {
    it('handles realistic chain latency (50ms per submission)', async () => {
      const ANCHOR_COUNT = 20;
      seedAnchors(ANCHOR_COUNT);

      mockSubmitFingerprint.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 50)); // Simulate 50ms chain latency
        return makeReceipt('latency-test');
      });
      mockDispatchWebhookEvent.mockResolvedValue(undefined);

      const { processPendingAnchors } = await import(
        '../../services/worker/src/jobs/anchor.js'
      );

      const start = performance.now();
      const result = await processPendingAnchors();
      const elapsed = performance.now() - start;

      expect(result.processed).toBe(ANCHOR_COUNT);

      // Sequential processing: 20 anchors * 50ms = ~1000ms minimum
      // With overhead, should be under 3000ms
      expect(elapsed).toBeLessThan(3000);

      console.log(
        `[LOAD] ${ANCHOR_COUNT} anchors with 50ms latency: ${elapsed.toFixed(0)}ms total`
      );
    });
  });
});
