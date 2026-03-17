/**
 * usePublicSearch + useIssuerRegistry Hook Tests (UF-02 / AUDIT-12)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePublicSearch, useIssuerRegistry } from './usePublicSearch';

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
      data: [{ org_id: 'o1', org_name: 'University of Michigan', org_domain: 'umich.edu', credential_count: 42 }],
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

    expect(result.current.error).toBe('RPC not found');
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
