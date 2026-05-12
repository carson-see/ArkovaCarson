/**
 * fetchAnchorStats — SCRUM-1786: reads per-status counts from
 * pipeline_dashboard_cache (refreshed every 2 min, pg_class.reltuples)
 * instead of the get_anchor_status_counts_fast RPC whose 1s per-status
 * timeouts produce -1 sentinels on the 2.9M-row anchors table.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPipelineCacheSelect, mockSelectLastSeen, mockSelectLast24, mockLogger } = vi.hoisted(() => {
  const mockPipelineCacheSelect = vi.fn();
  const mockSelectLastSeen = vi.fn();
  const mockSelectLast24 = vi.fn();
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return { mockPipelineCacheSelect, mockSelectLastSeen, mockSelectLast24, mockLogger };
});

vi.mock('./logger.js', () => ({ logger: mockLogger }));

vi.mock('./db.js', () => {
  const pipelineCacheChain: Record<string, unknown> = {};
  pipelineCacheChain.eq = vi.fn(() => pipelineCacheChain);
  pipelineCacheChain.single = vi.fn(() => mockPipelineCacheSelect());

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
      from: vi.fn((table: string) => {
        if (table === 'pipeline_dashboard_cache') {
          return { select: vi.fn(() => pipelineCacheChain) };
        }
        if (table === 'anchors') {
          return {
            select: vi.fn((_: string, opts?: { head?: boolean }) => {
              return opts?.head === false ? last24Chain : lastSeenChain;
            }),
          };
        }
        return {};
      }),
    },
  };
});

import { fetchAnchorStats } from './anchor-stats.js';

describe('fetchAnchorStats — pipeline dashboard cache path (SCRUM-1786)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectLastSeen.mockResolvedValue({
      data: [{ chain_timestamp: '2026-04-26T00:00:00Z' }],
      error: null,
    });
    mockSelectLast24.mockResolvedValue({ data: [], error: null });
  });

  it('reads SECURED + PENDING from pipeline_dashboard_cache', async () => {
    mockPipelineCacheSelect.mockResolvedValue({
      data: { cache_value: { SECURED: 1_500_000, PENDING: 42, total: 1_500_042 } },
      error: null,
    });

    const stats = await fetchAnchorStats();

    expect(stats.total_secured).toBe(1_500_000);
    expect(stats.total_pending).toBe(42);
    expect(stats.last_secured_at).toBe('2026-04-26T00:00:00Z');
  });

  it('pipeline cache error → secured/pending stay at -1 sentinel', async () => {
    mockPipelineCacheSelect.mockResolvedValue({
      data: null,
      error: { message: 'relation does not exist' },
    });

    const stats = await fetchAnchorStats();

    expect(stats.total_secured).toBe(-1);
    expect(stats.total_pending).toBe(-1);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('pipeline cache throws → sentinels, parallel queries unaffected', async () => {
    mockPipelineCacheSelect.mockRejectedValue(new Error('network down'));

    const stats = await fetchAnchorStats();

    expect(stats.total_secured).toBe(-1);
    expect(stats.total_pending).toBe(-1);
    expect(stats.last_24h_count).toBe(0);
  });

  it('partial: cache ok but lastSeen empty → last_secured_at null', async () => {
    mockPipelineCacheSelect.mockResolvedValue({
      data: { cache_value: { SECURED: 100, PENDING: 5, total: 105 } },
      error: null,
    });
    mockSelectLastSeen.mockResolvedValue({ data: [], error: null });

    const stats = await fetchAnchorStats();

    expect(stats.total_secured).toBe(100);
    expect(stats.last_secured_at).toBeNull();
  });

  it('cache_value missing SECURED field → sentinel for that field only', async () => {
    mockPipelineCacheSelect.mockResolvedValue({
      data: { cache_value: { PENDING: 42, total: 42 } },
      error: null,
    });

    const stats = await fetchAnchorStats();

    expect(stats.total_secured).toBe(-1);
    expect(stats.total_pending).toBe(42);
  });

  it('last_24h_count reports number of rows up to LIMIT cap', async () => {
    mockPipelineCacheSelect.mockResolvedValue({
      data: { cache_value: { SECURED: 0, PENDING: 0, total: 0 } },
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
