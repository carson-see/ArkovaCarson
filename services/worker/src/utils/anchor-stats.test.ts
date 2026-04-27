/**
 * fetchAnchorStats — verifies the get_anchor_status_counts_fast RPC
 * returns expected counts on the fast path AND degrades to -1 sentinels
 * on RPC error/throw (the caller's graceful-degradation contract).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRpc, mockSelectLastSeen, mockSelectLast24, mockLogger } = vi.hoisted(() => {
  const mockRpc = vi.fn();
  const mockSelectLastSeen = vi.fn();
  const mockSelectLast24 = vi.fn();
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return { mockRpc, mockSelectLastSeen, mockSelectLast24, mockLogger };
});

vi.mock('./logger.js', () => ({ logger: mockLogger }));

vi.mock('./db.js', () => {
  const lastSeenChain: Record<string, unknown> = {};
  lastSeenChain.eq = vi.fn(() => lastSeenChain);
  lastSeenChain.is = vi.fn(() => lastSeenChain);
  lastSeenChain.order = vi.fn(() => lastSeenChain);
  lastSeenChain.limit = vi.fn(() => mockSelectLastSeen());

  const last24Chain: Record<string, unknown> = {};
  last24Chain.is = vi.fn(() => last24Chain);
  last24Chain.gte = vi.fn(() => last24Chain);
  last24Chain.order = vi.fn(() => last24Chain);
  last24Chain.limit = vi.fn(() => mockSelectLast24());

  return {
    db: {
      rpc: mockRpc,
      from: vi.fn((table: string) => {
        if (table !== 'anchors') return {};
        return {
          select: vi.fn((_: string, opts?: { head?: boolean }) => {
            return opts?.head === false ? last24Chain : lastSeenChain;
          }),
        };
      }),
    },
  };
});

import { fetchAnchorStats } from './anchor-stats.js';

describe('fetchAnchorStats — fast RPC path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectLastSeen.mockResolvedValue({
      data: [{ chain_timestamp: '2026-04-26T00:00:00Z' }],
      error: null,
    });
    mockSelectLast24.mockResolvedValue({ data: [], error: null });
  });

  it('fast path: returns SECURED + PENDING from RPC', async () => {
    mockRpc.mockResolvedValue({
      data: { SECURED: 1_400_000, PENDING: 42, BROADCASTING: 0, SUBMITTED: 0, REVOKED: 0, total: 1_400_042 },
      error: null,
    });

    const stats = await fetchAnchorStats();

    expect(stats.total_secured).toBe(1_400_000);
    expect(stats.total_pending).toBe(42);
    expect(stats.last_secured_at).toBe('2026-04-26T00:00:00Z');
    expect(mockRpc).toHaveBeenCalledWith('get_anchor_status_counts_fast', undefined);
  });

  it('error path: RPC returns error → secured/pending stay at -1 sentinel', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'statement timeout' } });

    const stats = await fetchAnchorStats();

    expect(stats.total_secured).toBe(-1);
    expect(stats.total_pending).toBe(-1);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('error path: RPC throws → secured/pending sentinels, parallel queries unaffected', async () => {
    mockRpc.mockRejectedValue(new Error('network down'));

    const stats = await fetchAnchorStats();

    expect(stats.total_secured).toBe(-1);
    expect(stats.total_pending).toBe(-1);
    // Parallel last24 query still resolves; allSettled isolates the RPC throw.
    expect(stats.last_24h_count).toBe(0);
  });

  it('partial path: RPC ok but lastSeen empty → last_secured_at null', async () => {
    mockRpc.mockResolvedValue({
      data: { SECURED: 100, PENDING: 5, BROADCASTING: 0, SUBMITTED: 0, REVOKED: 0, total: 105 },
      error: null,
    });
    mockSelectLastSeen.mockResolvedValue({ data: [], error: null });

    const stats = await fetchAnchorStats();

    expect(stats.total_secured).toBe(100);
    expect(stats.last_secured_at).toBeNull();
  });

  it('last_24h_count reports number of rows up to LIMIT cap', async () => {
    mockRpc.mockResolvedValue({
      data: { SECURED: 0, PENDING: 0, BROADCASTING: 0, SUBMITTED: 0, REVOKED: 0, total: 0 },
      error: null,
    });
    mockSelectLast24.mockResolvedValue({
      data: Array.from({ length: 250 }, (_, i) => ({ id: `a${i}` })),
      error: null,
    });

    const stats = await fetchAnchorStats();

    expect(stats.last_24h_count).toBe(250);
  });
});
