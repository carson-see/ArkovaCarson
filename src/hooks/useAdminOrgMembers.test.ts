/**
 * useAdminOrgMembers Hook Tests
 *
 * Verifies the platform-admin roster path: fetches via the service_role worker
 * endpoint, maps to Member shape, stays idle when disabled (so non-admins never
 * hit the 403-bound endpoint), and surfaces errors.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createQueryWrapper } from '@/tests/queryTestUtils';

const mockWorkerFetch = vi.hoisted(() => vi.fn());

vi.mock('@/lib/workerClient', () => ({
  workerFetch: mockWorkerFetch,
}));

import { useAdminOrgMembers } from './useAdminOrgMembers';

describe('useAdminOrgMembers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not fetch when disabled', async () => {
    const { result } = renderHook(() => useAdminOrgMembers('org-1', false), {
      wrapper: createQueryWrapper(),
    });

    expect(mockWorkerFetch).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.members).toEqual([]);
  });

  it('does not fetch when orgId is null', async () => {
    const { result } = renderHook(() => useAdminOrgMembers(null, true), {
      wrapper: createQueryWrapper(),
    });

    expect(mockWorkerFetch).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it('fetches the roster from the admin endpoint and maps to Member shape', async () => {
    mockWorkerFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        members: [
          {
            id: 'u1',
            email: 'owner@acme.com',
            fullName: 'Owner One',
            avatarUrl: null,
            role: 'ORG_ADMIN',
            joinedAt: '2026-01-01T00:00:00Z',
            status: 'active',
          },
        ],
      }),
    });

    const { result } = renderHook(() => useAdminOrgMembers('org-1', true), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockWorkerFetch).toHaveBeenCalledWith(
      '/api/admin/organizations/org-1/members',
      { method: 'GET' },
    );
    expect(result.current.members).toEqual([
      {
        id: 'u1',
        email: 'owner@acme.com',
        fullName: 'Owner One',
        avatarUrl: null,
        role: 'ORG_ADMIN',
        joinedAt: '2026-01-01T00:00:00Z',
        status: 'active',
      },
    ]);
    expect(result.current.error).toBeNull();
  });

  it('surfaces an error when the endpoint returns non-ok', async () => {
    mockWorkerFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Forbidden — platform admin access required' }),
    });

    const { result } = renderHook(() => useAdminOrgMembers('org-1', true), {
      wrapper: createQueryWrapper(),
    });

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toBe('Forbidden — platform admin access required');
    expect(result.current.members).toEqual([]);
  });
});
