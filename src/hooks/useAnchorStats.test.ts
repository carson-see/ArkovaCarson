// Pins: when get_anchor_tx_stats returns 42501 (permission denied), the hook
// returns zero/null tx fields and DOES NOT fall back to count:'exact' against
// the bloated anchors table (that path timed out the dashboard at 30s).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcMock = vi.fn();
const fromMock = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

import { fetchAnchorStatsData } from './useAnchorStats';

beforeEach(() => {
  rpcMock.mockReset();
  fromMock.mockReset();
});

describe('fetchAnchorStatsData', () => {
  it('returns full stats when both RPCs succeed', async () => {
    rpcMock.mockImplementation((name: string) => {
      if (name === 'get_anchor_status_counts') {
        return Promise.resolve({
          data: { PENDING: 5, BROADCASTING: 0, SUBMITTED: 10, SECURED: 80, REVOKED: 0 },
          error: null,
        });
      }
      if (name === 'get_anchor_tx_stats') {
        return Promise.resolve({
          data: {
            distinct_tx_count: 8,
            anchors_with_tx: 90,
            last_anchor_time: '2026-04-27T10:00:00Z',
            last_tx_time: '2026-04-27T09:55:00Z',
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: { message: 'unknown rpc' } });
    });

    const stats = await fetchAnchorStatsData();
    expect(stats.totalAnchors).toBe(95);
    expect(stats.distinctTxIds).toBe(8);
    expect(stats.avgAnchorsPerTx).toBe(11);
    expect(stats.lastAnchorTime).toBe('2026-04-27T10:00:00Z');
    expect(stats.lastTxTime).toBe('2026-04-27T09:55:00Z');
  });

  it('falls back to zeros when get_anchor_tx_stats is forbidden (42501) and never issues count:exact', async () => {
    rpcMock.mockImplementation((name: string) => {
      if (name === 'get_anchor_status_counts') {
        return Promise.resolve({
          data: { PENDING: 5, BROADCASTING: 0, SUBMITTED: 10, SECURED: 80, REVOKED: 0 },
          error: null,
        });
      }
      if (name === 'get_anchor_tx_stats') {
        return Promise.resolve({
          data: null,
          error: { code: '42501', message: 'permission denied for function get_anchor_tx_stats' },
        });
      }
      return Promise.resolve({ data: null, error: { message: 'unknown rpc' } });
    });

    const stats = await fetchAnchorStatsData();
    expect(stats.totalAnchors).toBe(95);
    expect(stats.distinctTxIds).toBe(0);
    expect(stats.avgAnchorsPerTx).toBe(0);
    expect(stats.lastAnchorTime).toBeNull();
    expect(stats.lastTxTime).toBeNull();
    // No count:'exact' fallback path may run (those caused 30s timeouts).
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('throws when get_anchor_status_counts is unavailable so React Query surfaces the error', async () => {
    rpcMock.mockImplementation((name: string) => {
      if (name === 'get_anchor_status_counts') {
        return Promise.resolve({
          data: null,
          error: { message: 'function unavailable' },
        });
      }
      return Promise.resolve({ data: {}, error: null });
    });

    await expect(fetchAnchorStatsData()).rejects.toThrow(/get_anchor_status_counts RPC unavailable/);
  });
});
