/* eslint-disable arkova/require-error-code-assertion -- Error shape varies by Supabase operation; specific codes tested in RLS integration suite */
/**
 * useRevokeAnchor Hook Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist the mock function so it's available before module initialization
const mockRpc = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: mockRpc,
  },
}));

// Import after mock
import { renderHook, act } from '@testing-library/react';
import { useRevokeAnchor } from './useRevokeAnchor';

describe('useRevokeAnchor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should successfully revoke an anchor', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });

    const { result } = renderHook(() => useRevokeAnchor());

    let success: boolean;
    await act(async () => {
      success = await result.current.revokeAnchor('test-anchor-id');
    });

    expect(success!).toBe(true);
    expect(mockRpc).toHaveBeenCalledWith('revoke_anchor', {
      anchor_id: 'test-anchor-id',
      reason: null,
    });
    expect(result.current.error).toBeNull();
  });

  it('should handle insufficient privilege error', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'insufficient_privilege: Only org admins can revoke' },
    });

    const { result } = renderHook(() => useRevokeAnchor());

    let success: boolean;
    await act(async () => {
      success = await result.current.revokeAnchor('test-anchor-id');
    });

    expect(success!).toBe(false);
    expect(result.current.error).toContain('permission');
  });

  it('should handle already revoked error', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'Anchor is already revoked' },
    });

    const { result } = renderHook(() => useRevokeAnchor());

    let success: boolean;
    await act(async () => {
      success = await result.current.revokeAnchor('test-anchor-id');
    });

    expect(success!).toBe(false);
    expect(result.current.error).toContain('already been revoked');
  });

  it('should handle legal hold error', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'Cannot revoke anchor under legal hold' },
    });

    const { result } = renderHook(() => useRevokeAnchor());

    let success: boolean;
    await act(async () => {
      success = await result.current.revokeAnchor('test-anchor-id');
    });

    expect(success!).toBe(false);
    expect(result.current.error).toContain('legal hold');
  });

  it('should clear error when clearError is called', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'Some error' },
    });

    const { result } = renderHook(() => useRevokeAnchor());

    await act(async () => {
      await result.current.revokeAnchor('test-anchor-id');
    });

    expect(result.current.error).not.toBeNull();

    act(() => {
      result.current.clearError();
    });

    expect(result.current.error).toBeNull();
  });
});
