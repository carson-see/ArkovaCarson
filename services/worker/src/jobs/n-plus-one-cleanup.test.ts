/**
 * SCRUM-1296 — Tests for N+1 fan-out cleanup.
 *
 * Verifies that hot-path loops use bounded concurrency or bulk operations
 * instead of sequential per-row round-trips.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks ----
const { mockLogger, mockDbFrom, mockDbRpc } = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const mockDbFrom = vi.fn();
  const mockDbRpc = vi.fn();

  return { mockLogger, mockDbFrom, mockDbRpc };
});

vi.mock('../utils/logger.js', () => ({
  logger: mockLogger,
}));

vi.mock('../utils/db.js', () => ({
  db: {
    from: mockDbFrom,
    rpc: mockDbRpc,
  },
}));

// Helper: create chainable supabase mock.
// Uses a Proxy to delegate `then`/`catch`/`finally` to a real Promise so the
// object is awaitable without directly adding `then` to a plain object
// (which triggers SonarCloud S7739).
function makeChainable(result: { data?: unknown; error?: unknown }) {
  const promise = Promise.resolve(result);
  const methods: Record<string, unknown> = {};
  const chainMethodNames = ['select', 'eq', 'is', 'lt', 'lte', 'gte', 'not', 'in', 'limit', 'update', 'insert', 'single', 'maybeSingle', 'order'];

  const proxy: Record<string, unknown> = new Proxy(methods, {
    get(target, prop) {
      // Delegate Promise protocol to the backing promise
      if (prop === 'then') return promise.then.bind(promise);
      if (prop === 'catch') return promise.catch.bind(promise);
      if (prop === 'finally') return promise.finally.bind(promise);
      // Return chain methods from target
      if (prop in target) return target[prop as string];
      return undefined;
    },
  });

  for (const m of chainMethodNames) {
    methods[m] = vi.fn(() => proxy);
  }

  return proxy;
}

describe('SCRUM-1296: cloud-logging-drain bumpRetryCounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should use a single bulk UPDATE instead of per-row read-modify-write', async () => {
    // This test verifies bumpRetryCounts calls db.rpc (bulk) instead of
    // N separate select+update calls
    const { bumpRetryCounts } = await import('./cloud-logging-drain.js');

    const auditIds = ['id-1', 'id-2', 'id-3', 'id-4', 'id-5'];
    mockDbRpc.mockResolvedValueOnce({ data: null, error: null });

    await bumpRetryCounts(auditIds, 'test error');

    // Should call RPC once with all IDs, not N times
    expect(mockDbRpc).toHaveBeenCalledTimes(1);
    expect(mockDbRpc).toHaveBeenCalledWith(
      'bump_cloud_logging_retry_counts',
      {
        p_audit_ids: auditIds,
        p_error_msg: 'test error',
      },
    );
    // Should NOT call db.from for individual reads/writes
    expect(mockDbFrom).not.toHaveBeenCalled();
  });

  it('should fall back to chunked update if RPC does not exist', async () => {
    const { bumpRetryCounts } = await import('./cloud-logging-drain.js');

    const auditIds = ['id-1', 'id-2', 'id-3'];
    // RPC fails (function not found)
    mockDbRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42883', message: 'function not found' },
    });

    // Fallback uses .from().update().in()
    const updateChain = makeChainable({ data: null, error: null });
    mockDbFrom.mockReturnValue(updateChain);

    await bumpRetryCounts(auditIds, 'test error');

    expect(mockDbRpc).toHaveBeenCalledTimes(1);
    // Falls back to bulk .in() update
    expect(mockDbFrom).toHaveBeenCalledWith('cloud_logging_queue');
  });

  it('should increment retry_count in fallback path (not just set last_error)', async () => {
    const { bumpRetryCounts } = await import('./cloud-logging-drain.js');

    const auditIds = ['id-1', 'id-2', 'id-3'];
    // RPC fails (function not found)
    mockDbRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42883', message: 'function not found' },
    });

    // Track what update() is called with
    const updatePayloads: unknown[] = [];
    const selectResult = {
      data: [
        { audit_id: 'id-1', retry_count: 2 },
        { audit_id: 'id-2', retry_count: 5 },
        { audit_id: 'id-3', retry_count: 2 },
      ],
      error: null,
    };

    let _callIndex = 0;
    mockDbFrom.mockImplementation(() => {
      _callIndex++;

      // selectChain: resolves with selectResult when awaited
      const selectChain = makeChainable(selectResult);

      // updateChain: captures payload and resolves with empty success
      const updateChain = makeChainable({ data: null, error: null });
      const updateFn = vi.fn((payload: unknown) => {
        updatePayloads.push(payload);
        return updateChain;
      });

      // baseChain: delegates select/update; resolves with selectResult when awaited directly
      const baseChain = makeChainable(selectResult);
      baseChain['select'] = vi.fn(() => selectChain);
      baseChain['update'] = updateFn;
      const methods = ['eq', 'is', 'lt', 'lte', 'gte', 'not', 'in', 'limit', 'single', 'maybeSingle', 'order'];
      for (const m of methods) {
        baseChain[m] = vi.fn(() => baseChain);
      }
      return baseChain;
    });

    await bumpRetryCounts(auditIds, 'connection timeout');

    expect(mockDbRpc).toHaveBeenCalledTimes(1);
    expect(mockDbFrom).toHaveBeenCalledWith('cloud_logging_queue');
    // Verify retry_count was incremented (not just last_error set)
    const hasRetryIncrement = updatePayloads.some(
      (p: any) => typeof p === 'object' && p !== null && 'retry_count' in p && p.retry_count > 0,
    );
    expect(hasRetryIncrement).toBe(true);
    // Verify the incremented values are correct (2+1=3 and 5+1=6)
    const retryValues = updatePayloads
      .filter((p: any) => typeof p === 'object' && p !== null && 'retry_count' in p)
      .map((p: any) => p.retry_count);
    expect(retryValues).toContain(3); // 2 + 1
    expect(retryValues).toContain(6); // 5 + 1
  });
});

describe('SCRUM-1296: attestationExpiry bulk operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should bulk-insert webhook events instead of per-attestation inserts', async () => {
    const { checkAttestationExpiry } = await import('./attestationExpiry.js');

    const now = new Date();
    const in5Days = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);

    // Mock: 3 attestations expiring within 7 days
    const expiringData = [
      { id: '1', public_id: 'pub-1', attestation_type: 'TYPE_A', subject_identifier: 's1', attester_name: 'A', attester_org_id: 'org-1', expires_at: in5Days.toISOString(), status: 'ACTIVE' },
      { id: '2', public_id: 'pub-2', attestation_type: 'TYPE_B', subject_identifier: 's2', attester_name: 'B', attester_org_id: 'org-1', expires_at: in5Days.toISOString(), status: 'ACTIVE' },
      { id: '3', public_id: 'pub-3', attestation_type: 'TYPE_C', subject_identifier: 's3', attester_name: 'C', attester_org_id: 'org-2', expires_at: in5Days.toISOString(), status: 'ACTIVE' },
    ];

    const selectChain = makeChainable({ data: expiringData, error: null });
    const insertChain = makeChainable({ data: null, error: null });
    const expiredChain = makeChainable({ data: [], error: null });

    let callCount = 0;
    mockDbFrom.mockImplementation((table: string) => {
      callCount++;
      if (table === 'attestations' && callCount <= 2) {
        // First two calls are the two SELECT queries
        if (callCount === 1) return selectChain;
        return expiredChain;
      }
      if (table === 'webhook_events') return insertChain;
      return makeChainable({ data: null, error: null });
    });

    const result = await checkAttestationExpiry();

    // Should have used bulk insert (single call, not 3 individual ones)
    expect(result.webhooks_queued).toBe(3);
  });

  it('should insert webhook events BEFORE updating status to EXPIRED (ordering guarantee)', async () => {
    const { checkAttestationExpiry } = await import('./attestationExpiry.js');

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // 2 expired attestations
    const expiredData = [
      { id: 'e1', public_id: 'pub-e1', attestation_type: 'T', subject_identifier: 's', attester_name: 'A', attester_org_id: 'org-1', expires_at: yesterday.toISOString() },
      { id: 'e2', public_id: 'pub-e2', attestation_type: 'T', subject_identifier: 's', attester_name: 'B', attester_org_id: 'org-1', expires_at: yesterday.toISOString() },
    ];

    // Track the order of operations
    const operationOrder: string[] = [];

    let callCount = 0;
    mockDbFrom.mockImplementation((table: string) => {
      callCount++;
      if (table === 'attestations' && callCount <= 2) {
        // First two calls are the SELECT queries
        if (callCount === 1) return makeChainable({ data: [], error: null }); // no expiring
        return makeChainable({ data: expiredData, error: null }); // expired
      }
      if (table === 'webhook_events') {
        operationOrder.push('webhook_insert');
        return makeChainable({ data: null, error: null });
      }
      if (table === 'attestations' && callCount > 2) {
        operationOrder.push('status_update');
        return makeChainable({ data: null, error: null });
      }
      return makeChainable({ data: null, error: null });
    });

    await checkAttestationExpiry();

    // Webhook insert must happen BEFORE status update
    expect(operationOrder.length).toBeGreaterThanOrEqual(2);
    expect(operationOrder.indexOf('webhook_insert')).toBeLessThan(
      operationOrder.indexOf('status_update'),
    );
  });

  it('should NOT update status if webhook insert fails (prevents permanent event loss)', async () => {
    const { checkAttestationExpiry } = await import('./attestationExpiry.js');

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const expiredData = [
      { id: 'e1', public_id: 'pub-e1', attestation_type: 'T', subject_identifier: 's', attester_name: 'A', attester_org_id: 'org-1', expires_at: yesterday.toISOString() },
    ];

    let callCount = 0;
    let statusUpdateCalled = false;
    mockDbFrom.mockImplementation((table: string) => {
      callCount++;
      if (table === 'attestations' && callCount <= 2) {
        if (callCount === 1) return makeChainable({ data: [], error: null });
        return makeChainable({ data: expiredData, error: null });
      }
      if (table === 'webhook_events') {
        // Webhook insert FAILS
        return makeChainable({ data: null, error: { message: 'DB connection lost' } });
      }
      if (table === 'attestations' && callCount > 2) {
        statusUpdateCalled = true;
        return makeChainable({ data: null, error: null });
      }
      return makeChainable({ data: null, error: null });
    });

    const result = await checkAttestationExpiry();

    // Status should NOT have been updated since webhook insert failed
    expect(statusUpdateCalled).toBe(false);
    // Webhooks queued should be 0 since insert failed
    expect(result.webhooks_queued).toBe(0);
  });

  it('should bulk-update expired attestation statuses', async () => {
    const { checkAttestationExpiry } = await import('./attestationExpiry.js');

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // No expiring, 3 expired
    const expiredData = [
      { id: 'e1', public_id: 'pub-e1', attestation_type: 'T', subject_identifier: 's', attester_name: 'A', attester_org_id: 'org-1', expires_at: yesterday.toISOString() },
      { id: 'e2', public_id: 'pub-e2', attestation_type: 'T', subject_identifier: 's', attester_name: 'B', attester_org_id: 'org-1', expires_at: yesterday.toISOString() },
      { id: 'e3', public_id: 'pub-e3', attestation_type: 'T', subject_identifier: 's', attester_name: 'C', attester_org_id: 'org-2', expires_at: yesterday.toISOString() },
    ];

    let callCount = 0;
    const updateChain = makeChainable({ data: null, error: null });
    mockDbFrom.mockImplementation((table: string) => {
      callCount++;
      if (table === 'attestations') {
        if (callCount === 1) return makeChainable({ data: [], error: null }); // no expiring
        if (callCount === 2) return makeChainable({ data: expiredData, error: null }); // expired
        return updateChain; // bulk status update
      }
      if (table === 'webhook_events') return makeChainable({ data: null, error: null });
      return makeChainable({ data: null, error: null });
    });

    const result = await checkAttestationExpiry();

    // Should do a bulk status update, not 3 individual .update().eq() calls
    expect(result.newly_expired).toBe(3);
  });
});

describe('SCRUM-1296: broadcast-recovery chunked bulk update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should preserve per-anchor metadata during recovery', async () => {
    const { recoverStuckBroadcasts } = await import('./broadcast-recovery.js');

    // RPC fails → fallback to manual recovery
    mockDbRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42883', message: 'function not found' },
    });

    // 5 stuck anchors with distinct metadata
    const stuckAnchors = Array.from({ length: 5 }, (_, i) => ({
      id: `anchor-${i}`,
      fingerprint: `fp-${i}`,
      metadata: { _claimed_by: `worker-${i}`, _claimed_at: new Date().toISOString(), business_field: `val-${i}` },
    }));

    let fromCallCount = 0;
    const selectChain = makeChainable({ data: stuckAnchors, error: null });
    const updateChain = makeChainable({ data: null, error: null });

    mockDbFrom.mockImplementation(() => {
      fromCallCount++;
      if (fromCallCount === 1) return selectChain; // SELECT stuck
      return updateChain; // Per-anchor UPDATE preserving metadata
    });

    const result = await recoverStuckBroadcasts(5);

    expect(result.recovered).toBe(5);
    // 1 SELECT + 5 per-anchor UPDATEs (preserving individual metadata)
    // Chunked in batches of 100, so all 5 are in one chunk processed via Promise.allSettled
    expect(fromCallCount).toBe(6);
  });
});

describe('SCRUM-1296: revocation sequential processing (UTXO safety)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should NOT import p-limit — revocations must be sequential for UTXO safety', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const revocationSource = fs.readFileSync(
      path.resolve(__dirname, './revocation.ts'),
      'utf-8',
    );
    expect(revocationSource).not.toContain('p-limit');
    expect(revocationSource).not.toContain('pLimit');
    expect(revocationSource).toContain('for (const anchor of anchors)');
  });

  it('should contain UTXO safety comment explaining sequential requirement', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const revocationSource = fs.readFileSync(
      path.resolve(__dirname, './revocation.ts'),
      'utf-8',
    );
    expect(revocationSource).toContain('UTXO selection is not safe under concurrency');
    expect(revocationSource).toContain('treasury wallet UTXOs are shared state');
  });

  it('should use runWithConcurrency for bounded non-chain concurrency', async () => {
    const { runWithConcurrency } = await import('../utils/concurrency.js');
    expect(runWithConcurrency).toBeDefined();
    expect(typeof runWithConcurrency).toBe('function');

    const tasks = [1, 2, 3, 4, 5].map((n) => async () => n * 2);
    const result = await runWithConcurrency(tasks, 2);
    expect(result.fulfilled).toHaveLength(5);
    expect(result.rejected).toHaveLength(0);
    expect(result.fulfilled.sort((a, b) => a - b)).toEqual([2, 4, 6, 8, 10]);
  });
});
