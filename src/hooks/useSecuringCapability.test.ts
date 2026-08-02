/**
 * useSecuringCapability Hook Tests
 *
 * @see QUEUE-01 / SCRUM-2894 (L2-A1)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createQueryWrapper } from '@/tests/queryTestUtils';

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

import { useSecuringCapability } from './useSecuringCapability';

describe('useSecuringCapability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is fail-closed: canSecureInstantly is always false this sprint (R5 dark)', async () => {
    mockRpc.mockResolvedValue({
      data: { balance: 50, monthly_allocation: 50, purchased: 0, plan_name: 'Free', cycle_start: null, cycle_end: null, is_low: false },
      error: null,
    });

    const { result } = renderHook(() => useSecuringCapability(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.capability.canSecureInstantly).toBe(false);
  });

  it('sources creditBalance from user-scoped credits (R4)', async () => {
    mockRpc.mockResolvedValue({
      data: { balance: 7, monthly_allocation: 50, purchased: 0, plan_name: 'Free', cycle_start: null, cycle_end: null, is_low: false },
      error: null,
    });

    const { result } = renderHook(() => useSecuringCapability(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.capability.creditBalance).toBe(7));
  });

  it('defaults creditBalance to 0 when credits have not loaded yet', () => {
    mockRpc.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useSecuringCapability(), { wrapper: createQueryWrapper() });

    expect(result.current.capability.creditBalance).toBe(0);
  });

  it('sets instantSecureCost to 1 credit per document', async () => {
    mockRpc.mockResolvedValue({
      data: { balance: 10, monthly_allocation: 50, purchased: 0, plan_name: 'Free', cycle_start: null, cycle_end: null, is_low: false },
      error: null,
    });

    const { result } = renderHook(() => useSecuringCapability(), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.capability.instantSecureCost).toBe(1);
  });
});
