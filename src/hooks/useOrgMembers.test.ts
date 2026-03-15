/**
 * useOrgMembers Hook Tests
 *
 * @see P5-TS-03
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const mockOrder = vi.hoisted(() => vi.fn());
const mockEq = vi.hoisted(() => vi.fn());
const mockSelect = vi.hoisted(() => vi.fn());
const mockFrom = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: mockFrom,
  },
}));

import { useOrgMembers } from './useOrgMembers';

describe('useOrgMembers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockReturnValue({ select: mockSelect });
    mockSelect.mockReturnValue({ eq: mockEq });
    mockEq.mockReturnValue({ order: mockOrder });
  });

  it('returns empty members and stops loading when no orgId', async () => {
    const { result } = renderHook(() => useOrgMembers(null));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.members).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('fetches and maps members from profiles table', async () => {
    const mockProfiles = [
      {
        id: 'u1',
        email: 'alice@test.com',
        full_name: 'Alice',
        avatar_url: null,
        role: 'ORG_ADMIN',
        created_at: '2026-01-01T00:00:00Z',
      },
    ];

    mockOrder.mockResolvedValue({ data: mockProfiles, error: null });

    const { result } = renderHook(() => useOrgMembers('org-1'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.members).toHaveLength(1);
    expect(result.current.members[0]).toEqual({
      id: 'u1',
      email: 'alice@test.com',
      fullName: 'Alice',
      avatarUrl: null,
      role: 'ORG_ADMIN',
      joinedAt: '2026-01-01T00:00:00Z',
      status: 'active',
    });
  });

  it('sets error when query fails', async () => {
    mockOrder.mockResolvedValue({
      data: null,
      error: { message: 'Permission denied' },
    });

    const { result } = renderHook(() => useOrgMembers('org-1'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('Permission denied');
    expect(result.current.members).toEqual([]);
  });
});
