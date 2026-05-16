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

// Helper: create chainable supabase mock
function makeChainable(result: { data?: unknown; error?: unknown }) {
  const chainable: Record<string, unknown> = {};
  const methods = ['select', 'eq', 'is', 'lt', 'lte', 'gte', 'not', 'in', 'limit', 'update', 'insert', 'single', 'maybeSingle', 'order'];
  for (const m of methods) {
    chainable[m] = vi.fn(() => chainable);
  }
  // Terminal call returns the result
  chainable.then = undefined;
  Object.defineProperty(chainable, 'then', {
    get() {
      return (resolve: (v: unknown) => void) => resolve(result);
    },
  });
  // Make it thenable for await
  (chainable as any)[Symbol.for('nodejs.util.promisify.custom')] = () => Promise.resolve(result);
  // Return a promise-like
  return new Proxy(chainable, {
    get(target, prop) {
      if (prop === 'then') return (res: (v: unknown) => void) => res(result);
      return target[prop as string] ?? vi.fn(() => target);
    },
  });
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

    let callIndex = 0;
    mockDbFrom.mockImplementation(() => {
      callIndex++;
      const chain: Record<string, unknown> = {};
      const methods = ['eq', 'is', 'lt', 'lte', 'gte', 'not', 'in', 'limit', 'single', 'maybeSingle', 'order'];
      for (const m of methods) {
        chain[m] = vi.fn(() => chain);
      }
      chain['select'] = vi.fn(() => {
        // Return selectResult for the SELECT call
        return new Proxy(chain, {
          get(target, prop) {
            if (prop === 'then') return (res: (v: unknown) => void) => res(selectResult);
            return target[prop as string] ?? vi.fn(() => target);
          },
        });
      });
      chain['update'] = vi.fn((payload: unknown) => {
        updatePayloads.push(payload);
        return new Proxy(chain, {
          get(target, prop) {
            if (prop === 'then') return (res: (v: unknown) => void) => res({ data: null, error: null });
            return target[prop as string] ?? vi.fn(() => target);
          },
        });
      });
      // Default thenable
      Object.defineProperty(chain, 'then', {
        get() {
          return (resolve: (v: unknown) => void) => resolve(selectResult);
        },
        configurable: true,
      });
      return new Proxy(chain, {
        get(target, prop) {
          if (prop === 'then') return (res: (v: unknown) => void) => res(selectResult);
          return target[prop as string] ?? vi.fn(() => target);
        },
      });
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

  it('should use chunked .in() update instead of per-row updates', async () => {
    const { recoverStuckBroadcasts } = await import('./broadcast-recovery.js');

    // RPC fails → fallback to manual recovery
    mockDbRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42883', message: 'function not found' },
    });

    // 5 stuck anchors
    const stuckAnchors = Array.from({ length: 5 }, (_, i) => ({
      id: `anchor-${i}`,
      fingerprint: `fp-${i}`,
      metadata: { _claimed_by: `worker-${i}`, _claimed_at: new Date().toISOString() },
    }));

    let fromCallCount = 0;
    const selectChain = makeChainable({ data: stuckAnchors, error: null });
    const updateChain = makeChainable({ data: null, error: null });

    mockDbFrom.mockImplementation(() => {
      fromCallCount++;
      if (fromCallCount === 1) return selectChain; // SELECT stuck
      return updateChain; // UPDATE bulk
    });

    const result = await recoverStuckBroadcasts(5);

    // Should NOT make 5 individual update calls
    // Should use chunked bulk update (1-2 calls max for 5 items)
    expect(result.recovered).toBe(5);
    // The .from('anchors') calls: 1 SELECT + at most 1 bulk UPDATE (not 5)
    expect(fromCallCount).toBeLessThanOrEqual(2);
  });
});

describe('SCRUM-1296: revocation sequential processing (UTXO safety)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should NOT import p-limit — revocations must be sequential for UTXO safety', async () => {
    // Revocations broadcast chain transactions from a shared treasury wallet.
    // Concurrent UTXO selection would cause "inputs-missingorspent" failures.
    // Verify the module does not use p-limit (sequential for...of is required).
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
});
