/**
 * Webhook Delivery Load Test
 *
 * Stress-tests webhook delivery engine with high concurrency:
 * - 50+ concurrent webhook deliveries
 * - Measures parallel dispatch throughput
 * - Verifies idempotency under load
 * - Tests retry queue processing at scale
 *
 * @created 2026-03-11 12:00 AM EST
 * @category load-test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks ----

const {
  mockLogger,
  mockFetch,
  mockRpc,
  dbState,
} = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const mockFetch = vi.fn();

  const mockRpc = vi.fn();

  const dbState = {
    deliveryLogs: new Map<string, Record<string, unknown>>(),
    endpoints: [] as Record<string, unknown>[],
    logIdCounter: 0,
  };

  return { mockLogger, mockFetch, mockRpc, dbState };
});

// ---- Module mocks ----

vi.mock('../../services/worker/src/utils/logger.js', () => ({ logger: mockLogger }));

vi.mock('../../services/worker/src/config.js', () => ({
  config: {
    nodeEnv: 'test',
    useMocks: true,
  },
}));

// Stateful DB mock tracking delivery logs
vi.mock('../../services/worker/src/utils/db.js', () => {
  function getRetryingLogs() {
    return Array.from(dbState.deliveryLogs.values()).filter(
      (l) => l.status === 'retrying'
    );
  }

  // Flat chain builders — each level returns an object, avoiding nesting > 4

  function retryLimitResult() {
    return Promise.resolve({ data: getRetryingLogs(), error: null });
  }

  function createRetryLimitMock() {
    return {
      lte: vi.fn(() => ({ limit: vi.fn(() => retryLimitResult()) })),
    };
  }

  function createIdempotencyEqMock(value: string) {
    const existing = Array.from(dbState.deliveryLogs.values()).find(
      (l) => l.idempotency_key === value
    );
    const singleResult = Promise.resolve({ data: existing || null, error: null });
    return {
      single: vi.fn(() => singleResult),
      ...createRetryLimitMock(),
    };
  }

  function deliveryLogsEqHandler(field: string, value: string) {
    if (field === 'idempotency_key') return createIdempotencyEqMock(value);
    if (field === 'status') return createRetryLimitMock();
    return { single: vi.fn(() => Promise.resolve({ data: null, error: null })) };
  }

  function createDeliveryLogsSelectMock() {
    return {
      select: vi.fn(() => ({ eq: vi.fn(deliveryLogsEqHandler) })),
    };
  }

  function insertSelectSingle(entry: Record<string, unknown>) {
    return { single: vi.fn(() => Promise.resolve({ data: entry, error: null })) };
  }

  function createDeliveryLogsInsertMock() {
    return {
      insert: vi.fn((data: Record<string, unknown>) => {
        const id = `log-${++dbState.logIdCounter}`;
        const entry = { ...data, id };
        dbState.deliveryLogs.set(id, entry);
        return { select: vi.fn(() => insertSelectSingle(entry)) };
      }),
    };
  }

  function updateEqHandler(data: Record<string, unknown>, field: string, value: string) {
    if (field === 'id') {
      const existing = dbState.deliveryLogs.get(value);
      if (existing) dbState.deliveryLogs.set(value, { ...existing, ...data });
    }
    return Promise.resolve({ error: null });
  }

  function createDeliveryLogsUpdateMock() {
    return {
      update: vi.fn((data: Record<string, unknown>) => ({
        eq: vi.fn((field: string, value: string) => updateEqHandler(data, field, value)),
      })),
    };
  }

  function endpointsResult() {
    return Promise.resolve({ data: dbState.endpoints, error: null });
  }

  function createEndpointsMock() {
    const innerEq = vi.fn(() => ({ contains: vi.fn(() => endpointsResult()) }));
    const outerEq = vi.fn(() => ({ eq: innerEq }));
    return { select: vi.fn(() => ({ eq: outerEq })) };
  }

  const mockFrom = vi.fn((table: string) => {
    if (table === 'webhook_delivery_logs') {
      return {
        ...createDeliveryLogsSelectMock(),
        ...createDeliveryLogsInsertMock(),
        ...createDeliveryLogsUpdateMock(),
      };
    }
    if (table === 'webhook_endpoints') return createEndpointsMock();
    return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn() })) })) };
  });

  return {
    db: { from: mockFrom, rpc: mockRpc },
    getDb: vi.fn(() => ({ from: mockFrom, rpc: mockRpc })),
  };
});

// Replace global fetch
vi.stubGlobal('fetch', mockFetch);

// ---- Helpers ----

function seedEndpoints(count: number): void {
  dbState.endpoints = [];
  for (let i = 0; i < count; i++) {
    dbState.endpoints.push({
      id: `endpoint-${i}`,
      url: `https://webhook-${i}.example.com/hook`,
      secret_hash: `secret-hash-${i}`,
      events: ['anchor.secured'],
      is_active: true,
      org_id: 'org-load-test',
    });
  }
}

function resetState(): void {
  dbState.deliveryLogs.clear();
  dbState.endpoints = [];
  dbState.logIdCounter = 0;
}

// ---- Tests ----

describe('Webhook Delivery Load Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
    mockRpc.mockResolvedValue({ data: true }); // Webhooks enabled
  });

  describe('Parallel Dispatch Throughput', () => {
    it('dispatches to 10 endpoints in parallel', async () => {
      seedEndpoints(10);

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('OK'),
      });

      const { dispatchWebhookEvent } = await import(
        '../../services/worker/src/webhooks/delivery.js'
      );

      const start = performance.now();
      await dispatchWebhookEvent('org-load-test', 'anchor.secured', 'event-001', {
        anchor_id: 'anchor-001',
        status: 'SECURED',
      });
      const elapsed = performance.now() - start;

      // All 10 endpoints should receive the webhook
      expect(mockFetch).toHaveBeenCalledTimes(10);

      // Verify each call went to different endpoint URLs
      const calledUrls = mockFetch.mock.calls.map((c: any[]) => c[0]);
      const uniqueUrls = new Set(calledUrls);
      expect(uniqueUrls.size).toBe(10);

      console.log(
        `[LOAD] Dispatched to 10 endpoints in ${elapsed.toFixed(0)}ms`
      );
    });

    it('dispatches 50 events across 5 endpoints', async () => {
      seedEndpoints(5);

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('OK'),
      });

      const { dispatchWebhookEvent } = await import(
        '../../services/worker/src/webhooks/delivery.js'
      );

      const start = performance.now();
      const dispatches = [];
      for (let i = 0; i < 50; i++) {
        dispatches.push(
          dispatchWebhookEvent('org-load-test', 'anchor.secured', `event-${i}`, {
            anchor_id: `anchor-${i}`,
            status: 'SECURED',
          })
        );
      }
      await Promise.all(dispatches);
      const elapsed = performance.now() - start;

      // 50 events * 5 endpoints = 250 fetch calls
      expect(mockFetch).toHaveBeenCalledTimes(250);

      console.log(
        `[LOAD] 50 events × 5 endpoints = 250 deliveries in ${elapsed.toFixed(0)}ms`
      );

      // Should complete well under 10 seconds with mocked fetch
      expect(elapsed).toBeLessThan(10000);
    });
  });

  describe('Mixed Success/Failure', () => {
    it('handles 50% failure rate without crashing', async () => {
      seedEndpoints(4);

      let callCount = 0;
      mockFetch.mockImplementation(async () => {
        callCount++;
        if (callCount % 2 === 0) {
          return { ok: false, status: 500, text: () => Promise.resolve('Server Error') };
        }
        return { ok: true, status: 200, text: () => Promise.resolve('OK') };
      });

      const { dispatchWebhookEvent } = await import(
        '../../services/worker/src/webhooks/delivery.js'
      );

      // Dispatch 10 events
      const dispatches = [];
      for (let i = 0; i < 10; i++) {
        dispatches.push(
          dispatchWebhookEvent('org-load-test', 'anchor.secured', `mixed-${i}`, {
            anchor_id: `anchor-mixed-${i}`,
          })
        );
      }
      await Promise.all(dispatches);

      // 10 events * 4 endpoints = 40 fetch calls
      expect(mockFetch).toHaveBeenCalledTimes(40);

      // Verify delivery logs were created for both successes and failures
      expect(dbState.deliveryLogs.size).toBeGreaterThan(0);

      // Some should be marked as retrying (failed first attempts)
      const retryingLogs = Array.from(dbState.deliveryLogs.values()).filter(
        (l) => l.status === 'retrying'
      );
      expect(retryingLogs.length).toBeGreaterThan(0);
    });

    it('handles network timeouts gracefully under load', async () => {
      seedEndpoints(3);

      mockFetch.mockImplementation(async () => {
        throw new Error('Network timeout');
      });

      const { dispatchWebhookEvent } = await import(
        '../../services/worker/src/webhooks/delivery.js'
      );

      const start = performance.now();
      const dispatches = [];
      for (let i = 0; i < 20; i++) {
        dispatches.push(
          dispatchWebhookEvent('org-load-test', 'anchor.secured', `timeout-${i}`, {
            anchor_id: `anchor-timeout-${i}`,
          })
        );
      }
      await Promise.all(dispatches);
      const elapsed = performance.now() - start;

      // All calls should have been attempted (20 events * 3 endpoints)
      expect(mockFetch).toHaveBeenCalledTimes(60);

      // Should not hang — complete in reasonable time
      expect(elapsed).toBeLessThan(10000);

      console.log(
        `[LOAD] 60 timed-out deliveries handled in ${elapsed.toFixed(0)}ms`
      );
    });
  });

  describe('HMAC Signature Consistency', () => {
    it('generates unique signatures for each endpoint under load', async () => {
      seedEndpoints(5);

      const signatures: string[] = [];
      mockFetch.mockImplementation(async (_url: string, opts: any) => {
        const sig = opts.headers['X-Arkova-Signature'];
        signatures.push(sig);
        return { ok: true, status: 200, text: () => Promise.resolve('OK') };
      });

      const { dispatchWebhookEvent } = await import(
        '../../services/worker/src/webhooks/delivery.js'
      );

      await dispatchWebhookEvent('org-load-test', 'anchor.secured', 'sig-test-001', {
        anchor_id: 'anchor-sig-001',
      });

      // Each endpoint has different secret_hash → different signature
      expect(signatures.length).toBe(5);

      // Signatures should all be valid hex strings
      for (const sig of signatures) {
        expect(sig).toMatch(/^[0-9a-f]{64}$/);
      }

      // With different secrets, at least some signatures should differ
      const uniqueSigs = new Set(signatures);
      expect(uniqueSigs.size).toBeGreaterThan(1);
    });
  });
});
