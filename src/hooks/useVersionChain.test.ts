/**
 * useVersionChain Hook Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const mockFrom = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: mockFrom,
  },
}));

import { useVersionChain } from './useVersionChain';

function mockAnchor(overrides: Record<string, unknown> = {}) {
  return {
    id: 'anchor-1',
    public_id: 'pub-1',
    filename: 'doc.pdf',
    credential_type: 'DEGREE',
    status: 'SECURED',
    created_at: '2026-01-01T00:00:00Z',
    expires_at: null,
    revoked_at: null,
    version_number: 1,
    parent_anchor_id: null,
    user_id: 'user-1',
    ...overrides,
  };
}

describe('useVersionChain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty chain when anchorId is undefined', async () => {
    const { result } = renderHook(() => useVersionChain(undefined));

    // Should not trigger any fetch
    expect(result.current.chain).toEqual([]);
    expect(result.current.hasChain).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it('returns single-item chain for anchor with no lineage', async () => {
    const anchor = mockAnchor();

    mockFrom.mockImplementation((table: string) => {
      if (table === 'anchors') {
        return {
          select: () => ({
            eq: (col: string, val: string) => {
              if (col === 'id' && val === 'anchor-1') {
                return { single: () => Promise.resolve({ data: anchor, error: null }) };
              }
              if (col === 'parent_anchor_id') {
                return {
                  order: () => ({
                    limit: () => Promise.resolve({ data: [], error: null }),
                  }),
                };
              }
              return { single: () => Promise.resolve({ data: null, error: null }) };
            },
          }),
        };
      }
      return {};
    });

    const { result } = renderHook(() => useVersionChain('anchor-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.chain).toHaveLength(1);
    expect(result.current.chain[0].id).toBe('anchor-1');
    expect(result.current.chain[0].isCurrent).toBe(true);
    expect(result.current.hasChain).toBe(false); // single item = no chain
  });

  it('returns two-item chain for anchor with parent', async () => {
    const parent = mockAnchor({
      id: 'parent-1',
      public_id: 'pub-parent',
      filename: 'old-doc.pdf',
      version_number: 1,
      parent_anchor_id: null,
      expires_at: '2025-12-01T00:00:00Z',
    });
    const current = mockAnchor({
      id: 'anchor-2',
      version_number: 2,
      parent_anchor_id: 'parent-1',
    });

    mockFrom.mockImplementation((table: string) => {
      if (table === 'anchors') {
        return {
          select: () => ({
            eq: (col: string, val: string) => {
              if (col === 'id' && val === 'anchor-2') {
                return { single: () => Promise.resolve({ data: current, error: null }) };
              }
              if (col === 'id' && val === 'parent-1') {
                return { single: () => Promise.resolve({ data: parent, error: null }) };
              }
              if (col === 'parent_anchor_id') {
                return {
                  order: () => ({
                    limit: () => Promise.resolve({ data: [], error: null }),
                  }),
                };
              }
              return { single: () => Promise.resolve({ data: null, error: null }) };
            },
          }),
        };
      }
      return {};
    });

    const { result } = renderHook(() => useVersionChain('anchor-2'));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.chain).toHaveLength(2);
    expect(result.current.chain[0].id).toBe('parent-1');
    expect(result.current.chain[0].isCurrent).toBe(false);
    expect(result.current.chain[1].id).toBe('anchor-2');
    expect(result.current.chain[1].isCurrent).toBe(true);
    expect(result.current.hasChain).toBe(true);
  });
});
