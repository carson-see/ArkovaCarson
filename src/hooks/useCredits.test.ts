/**
 * useCredits Hook Tests
 *
 * @see MVP-24
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const mockUser = { id: 'test-user-id' };

vi.mock('./useAuth', () => ({
  useAuth: () => ({ user: mockUser, loading: false }),
}));

const mockRpc = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));

import { useCredits } from './useCredits';

describe('useCredits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches credits on mount', async () => {
    mockRpc.mockResolvedValue({
      data: {
        balance: 45,
        monthly_allocation: 50,
        purchased: 0,
        plan_name: 'Free',
        cycle_start: '2026-03-01T00:00:00Z',
        cycle_end: '2026-04-01T00:00:00Z',
        is_low: false,
      },
      error: null,
    });

    const { result } = renderHook(() => useCredits());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.credits?.balance).toBe(45);
    expect(result.current.credits?.plan_name).toBe('Free');
    expect(result.current.error).toBeNull();
  });

  it('handles RPC error', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'RPC failed' },
    });

    const { result } = renderHook(() => useCredits());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('RPC failed');
    expect(result.current.credits).toBeNull();
  });

  it('detects low credit balance', async () => {
    mockRpc.mockResolvedValue({
      data: {
        balance: 5,
        monthly_allocation: 50,
        purchased: 0,
        plan_name: 'Free',
        cycle_start: null,
        cycle_end: null,
        is_low: true,
      },
      error: null,
    });

    const { result } = renderHook(() => useCredits());

    await waitFor(() => {
      expect(result.current.credits?.is_low).toBe(true);
    });
  });
});
