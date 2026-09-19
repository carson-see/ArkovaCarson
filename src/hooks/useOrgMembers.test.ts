/* eslint-disable arkova/no-mock-echo -- Integration test: verifies data flows through hook/component to rendered output */
/**
 * useOrgMembers Hook Tests
 *
 * @see P5-TS-03
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createQueryWrapper } from '@/tests/queryTestUtils';

const workerFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/workerClient', () => ({ workerFetch }));

import { useOrgMembers } from './useOrgMembers';

describe('useOrgMembers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty members and stops loading when no orgId', async () => {
    const { result } = renderHook(() => useOrgMembers(null), { wrapper: createQueryWrapper() });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.members).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('fetches and maps members from profiles table', async () => {
    const mockProfiles = [
      {
        id: '22222222-2222-4222-8222-222222222222',
        email: 'alice@test.com',
        full_name: 'Alice',
        avatar_url: null,
        role: 'ORG_ADMIN',
        created_at: '2026-01-01T00:00:00Z',
      },
    ];

    workerFetch.mockResolvedValue(new Response(JSON.stringify({ members: mockProfiles.map((row) => ({ ...row, org_id: '11111111-1111-4111-8111-111111111111', membership_role: 'admin' })) }), { status: 200 }));

    const { result } = renderHook(() => useOrgMembers('11111111-1111-4111-8111-111111111111'), { wrapper: createQueryWrapper() });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.members).toHaveLength(1);
    expect(result.current.members[0]).toEqual({
      id: '22222222-2222-4222-8222-222222222222',
      email: 'alice@test.com',
      fullName: 'Alice',
      avatarUrl: null,
      role: 'ORG_ADMIN',
      joinedAt: '2026-01-01T00:00:00Z',
      status: 'active',
    });
  });

  it('sets error when query fails', async () => {
    workerFetch.mockResolvedValue(new Response('{}', { status: 403 }));

    const { result } = renderHook(() => useOrgMembers('org-1'), { wrapper: createQueryWrapper() });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('member_list_failed');
    expect(result.current.members).toEqual([]);
  });
});
