/**
 * usePublicSearch + useIssuerRegistry Hook Tests (UF-02 / AUDIT-12)
 * + buildSubtreeIndex tests (SCRUM-1087)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  usePublicSearch,
  useIssuerRegistry,
  buildSubtreeIndex,
  type OrgSubtreeNode,
} from './usePublicSearch';

// Mock supabase with RPC
const mockRpc = vi.fn();
vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));

describe('usePublicSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts with empty results', () => {
    const { result } = renderHook(() => usePublicSearch());
    expect(result.current.issuerResults).toEqual([]);
    expect(result.current.searching).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('searches for issuers', async () => {
    mockRpc.mockResolvedValue({
      data: [{ id: 'o1', display_name: 'University of Michigan', legal_name: 'University of Michigan', public_id: 'pub1', verified: true, credential_count: 42 }],
      error: null,
    });

    const { result } = renderHook(() => usePublicSearch());

    await act(async () => {
      await result.current.searchIssuers('Michigan');
    });

    expect(result.current.issuerResults).toHaveLength(1);
    expect(result.current.issuerResults[0].org_name).toBe('University of Michigan');
  });

  it('skips empty queries', async () => {
    const { result } = renderHook(() => usePublicSearch());

    await act(async () => {
      await result.current.searchIssuers('  ');
    });

    expect(mockRpc).not.toHaveBeenCalled();
    expect(result.current.issuerResults).toEqual([]);
  });

  it('handles RPC errors', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'RPC not found' },
    });

    const { result } = renderHook(() => usePublicSearch());

    await act(async () => {
      await result.current.searchIssuers('test');
    });

    expect(result.current.error).toBe('Search failed. Please try again.');
  });

  it('clears results', async () => {
    mockRpc.mockResolvedValue({
      data: [{ org_id: 'o1', org_name: 'Test U', org_domain: null, credential_count: 1 }],
      error: null,
    });

    const { result } = renderHook(() => usePublicSearch());

    await act(async () => {
      await result.current.searchIssuers('test');
    });
    expect(result.current.issuerResults).toHaveLength(1);

    act(() => {
      result.current.clearResults();
    });
    expect(result.current.issuerResults).toEqual([]);
    expect(result.current.error).toBeNull();
  });
});

describe('useIssuerRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts with null registry', () => {
    const { result } = renderHook(() => useIssuerRegistry());
    expect(result.current.registry).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('fetches registry by org ID', async () => {
    const registryData = {
      org_id: 'o1',
      org_name: 'Test University',
      org_domain: 'test.edu',
      total: 5,
      anchors: [
        { public_id: 'ARK-001', credential_type: 'DIPLOMA', filename: 'diploma.pdf', issued_at: null, created_at: '2026-01-01', label: 'BSc CS' },
      ],
    };
    mockRpc.mockResolvedValue({ data: registryData, error: null });

    const { result } = renderHook(() => useIssuerRegistry());

    await act(async () => {
      await result.current.fetchRegistry('o1');
    });

    expect(result.current.registry?.org_name).toBe('Test University');
    expect(result.current.registry?.anchors).toHaveLength(1);
  });

  it('handles RPC errors', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Not found' } });

    const { result } = renderHook(() => useIssuerRegistry());

    await act(async () => {
      await result.current.fetchRegistry('nonexistent');
    });

    expect(result.current.error).toBe('Not found');
  });
});

// ─── SCRUM-1087: buildSubtreeIndex helper ─────────────────────────────────────

function subNode(over: Partial<OrgSubtreeNode>): OrgSubtreeNode {
  return {
    org_id: over.org_id ?? 'x',
    public_id: null,
    parent_org_id: null,
    display_name: over.display_name ?? 'X',
    domain: null,
    description: null,
    logo_url: null,
    banner_url: null,
    org_type: null,
    website_url: null,
    verification_status: null,
    verified_badge_granted_at: null,
    depth: over.depth ?? 1,
    ...over,
  };
}

describe('buildSubtreeIndex (SCRUM-1087)', () => {
  it('keys roots under null and children under their parent_org_id', () => {
    const idx = buildSubtreeIndex([
      subNode({ org_id: 'root', depth: 1, parent_org_id: null }),
      subNode({ org_id: 'child-a', depth: 2, parent_org_id: 'root' }),
      subNode({ org_id: 'child-b', depth: 2, parent_org_id: 'root' }),
      subNode({ org_id: 'grandchild', depth: 3, parent_org_id: 'child-a' }),
    ]);
    expect(idx.get(null)?.map((n) => n.org_id)).toEqual(['root']);
    expect(idx.get('root')?.map((n) => n.org_id).sort()).toEqual(['child-a', 'child-b']);
    expect(idx.get('child-a')?.map((n) => n.org_id)).toEqual(['grandchild']);
    expect(idx.get('grandchild')).toBeUndefined();
  });

  it('preserves the depth-ordered server payload within each parent bucket', () => {
    const idx = buildSubtreeIndex([
      subNode({ org_id: 'r', depth: 1, parent_org_id: null }),
      subNode({ org_id: 'c1', depth: 2, parent_org_id: 'r', display_name: 'Alpha' }),
      subNode({ org_id: 'c2', depth: 2, parent_org_id: 'r', display_name: 'Beta' }),
    ]);
    expect(idx.get('r')?.[0].display_name).toBe('Alpha');
    expect(idx.get('r')?.[1].display_name).toBe('Beta');
  });

  it('handles a flat list with no children (single root)', () => {
    const idx = buildSubtreeIndex([subNode({ org_id: 'only', parent_org_id: null })]);
    expect(idx.size).toBe(1);
    expect(idx.get(null)?.[0].org_id).toBe('only');
  });
});
