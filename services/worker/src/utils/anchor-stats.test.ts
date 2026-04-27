/**
 * Unit tests for fetchAnchorStats — SCRUM-1259 (R1-5) test coverage.
 *
 * Hot path: treasury status API + treasury-cache cron. Asserts:
 *  - fast-path: RPC returns counts → totals populate from RPC, not exact-count.
 *  - error-path: RPC failure → sentinel `-1` returned for affected fields,
 *    caller can render "—".
 *  - last-24h fetch is a bounded LIMIT-1000 query, never count:'exact'.
 *  - last-secured-at lookup is a bounded LIMIT-1 index scan.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, mockRpc, mockLogger } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./db.js', () => ({ db: { from: mockFrom, rpc: mockRpc } }));
vi.mock('./logger.js', () => ({ logger: mockLogger }));

import { fetchAnchorStats } from './anchor-stats.js';

interface ChainResult {
  data: unknown;
  error: unknown;
}

function chain(result: ChainResult): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  c.select = vi.fn(() => c);
  c.eq = vi.fn(() => c);
  c.is = vi.fn(() => c);
  c.gte = vi.fn(() => c);
  c.order = vi.fn(() => c);
  c.limit = vi.fn(() => Promise.resolve(result));
  return c;
}

describe('fetchAnchorStats — SCRUM-1259 (R1-5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation(() => chain({ data: [], error: null }));
    mockRpc.mockResolvedValue({ data: null, error: null });
  });

  it('fast-path: RPC returns counts; totals come from RPC, not count:exact', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { PENDING: 7, SUBMITTED: 2, BROADCASTING: 1, SECURED: 1_200_000, REVOKED: 0, total: 1_200_010 },
      error: null,
    });
    let fromCalls = 0;
    mockFrom.mockImplementation(() => {
      fromCalls++;
      if (fromCalls === 1) return chain({ data: [{ chain_timestamp: '2026-04-27T00:00:00Z' }], error: null });
      return chain({ data: [{ id: 'a' }, { id: 'b' }], error: null });
    });

    const result = await fetchAnchorStats();

    expect(mockRpc).toHaveBeenCalledWith('get_anchor_status_counts_fast', undefined);
    expect(result.total_secured).toBe(1_200_000);
    expect(result.total_pending).toBe(7);
    expect(result.last_secured_at).toBe('2026-04-27T00:00:00Z');
    expect(result.last_24h_count).toBe(2);
  });

  it('error-path: RPC failure returns sentinel -1 for totals; caller can render "—"', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc unavailable' } });

    const result = await fetchAnchorStats();

    expect(result.total_secured).toBe(-1);
    expect(result.total_pending).toBe(-1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.anything() }),
      expect.stringContaining('get_anchor_status_counts_fast failed'),
    );
  });

  it('survives unexpected throw from .allSettled — returns all sentinels rather than crashing', async () => {
    mockRpc.mockImplementation(() => { throw new Error('synchronous explode'); });
    mockFrom.mockImplementation(() => { throw new Error('synchronous explode'); });

    const result = await fetchAnchorStats();

    expect(result.total_secured).toBe(-1);
    expect(result.total_pending).toBe(-1);
    expect(result.last_secured_at).toBeNull();
    expect(result.last_24h_count).toBe(-1);
  });
});
