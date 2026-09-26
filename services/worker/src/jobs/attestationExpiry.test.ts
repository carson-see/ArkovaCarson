/**
 * ATT-08 — tests for the attestation expiry sweep's status-flip semantics.
 *
 * Review follow-up (PR #3091, P2): the bulk EXPIRED transition (1) counted
 * `newly_expired` from the SELECT candidate set rather than from rows the
 * UPDATE actually touched, so a chunk that partially failed (or a row a
 * concurrent transition already moved off ACTIVE) was still reported as
 * expired; and (2) issued the UPDATE keyed only on `id`, with no `status =
 * 'ACTIVE'` guard, so a row a concurrent process had already moved to e.g.
 * REVOKED between the SELECT and the UPDATE would be silently clobbered back
 * to EXPIRED. Both are fixed by re-asserting `status = 'ACTIVE'` in the
 * UPDATE's own WHERE clause and counting only the rows the UPDATE returns.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLogger, mockDbFrom } = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const mockDbFrom = vi.fn();
  return { mockLogger, mockDbFrom };
});

vi.mock('../utils/logger.js', () => ({
  logger: mockLogger,
}));

vi.mock('../utils/db.js', () => ({
  db: { from: mockDbFrom },
}));

/**
 * Chainable query-builder stub that records every method call (with its
 * arguments) so a test can assert the UPDATE was actually gated on
 * `status = 'ACTIVE'`, and resolves to `result` when awaited.
 */
function makeChainable(result: { data?: unknown; error?: unknown }, calls: Array<{ method: string; args: unknown[] }>) {
  const promise = Promise.resolve(result);
  const methods: Record<string, unknown> = {};
  const chainMethodNames = ['select', 'eq', 'is', 'lt', 'lte', 'gte', 'not', 'in', 'update', 'order'];

  const proxy: Record<string, unknown> = new Proxy(methods, {
    get(target, prop) {
      if (prop === 'then') return promise.then.bind(promise);
      if (prop === 'catch') return promise.catch.bind(promise);
      if (prop === 'finally') return promise.finally.bind(promise);
      if (prop in target) return target[prop as string];
      return undefined;
    },
  });

  for (const m of chainMethodNames) {
    methods[m] = vi.fn((...args: unknown[]) => {
      calls.push({ method: m, args });
      return proxy;
    });
  }

  return proxy;
}

import { checkAttestationExpiry } from './attestationExpiry.js';

describe('checkAttestationExpiry — bulk EXPIRED transition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Wires the two `attestations` queries the job makes in order:
   *   1. SELECT id, expires_at ... (30-day window, for the counters)
   *   2. SELECT id ... (candidates already past expiry)
   *   3. UPDATE ... (the bulk status flip)
   * Returns the recorded calls for the UPDATE call so a test can assert on
   * its WHERE clause.
   */
  function wire(opts: {
    candidateIds: string[];
    updateResult: { data?: unknown; error?: unknown };
  }) {
    const updateCalls: Array<{ method: string; args: unknown[] }> = [];
    let fromCallCount = 0;

    mockDbFrom.mockImplementation(() => {
      fromCallCount++;
      if (fromCallCount === 1) {
        // 30-day window select — empty is fine, unrelated to this test.
        return makeChainable({ data: [], error: null }, []);
      }
      if (fromCallCount === 2) {
        // just-expired candidate select.
        return makeChainable(
          { data: opts.candidateIds.map((id) => ({ id })), error: null },
          [],
        );
      }
      // The bulk UPDATE.
      return makeChainable(opts.updateResult, updateCalls);
    });

    return { updateCalls };
  }

  it('counts newly_expired from rows the UPDATE actually returns, not from the SELECT candidate count', async () => {
    // Three candidates past expiry, but the UPDATE (gated on status =
    // 'ACTIVE') only actually flips two of them — the third was concurrently
    // moved to REVOKED between the SELECT and the UPDATE and must not be
    // counted as expired.
    wire({
      candidateIds: ['a1', 'a2', 'a3'],
      updateResult: { data: [{ id: 'a1' }, { id: 'a2' }], error: null },
    });

    const result = await checkAttestationExpiry();

    expect(result.newly_expired).toBe(2);
  });

  it('gates the bulk UPDATE on status = ACTIVE so a concurrently-transitioned row cannot be clobbered back to EXPIRED', async () => {
    const { updateCalls } = wire({
      candidateIds: ['a1'],
      updateResult: { data: [{ id: 'a1' }], error: null },
    });

    await checkAttestationExpiry();

    const eqCalls = updateCalls.filter((c) => c.method === 'eq');
    expect(eqCalls).toContainEqual({ method: 'eq', args: ['status', 'ACTIVE'] });
  });

  it('does not count a chunk toward newly_expired when its UPDATE errors', async () => {
    wire({
      candidateIds: ['a1', 'a2'],
      updateResult: { data: null, error: { message: 'boom' } },
    });

    const result = await checkAttestationExpiry();

    expect(result.newly_expired).toBe(0);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('counts zero when there are no expired candidates at all', async () => {
    wire({ candidateIds: [], updateResult: { data: [], error: null } });

    const result = await checkAttestationExpiry();

    expect(result.newly_expired).toBe(0);
  });
});
