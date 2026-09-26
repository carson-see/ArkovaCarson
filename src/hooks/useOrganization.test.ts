/**
 * useOrganization Hook Tests
 *
 * Tests organization fetching, updating, error handling,
 * and toast/audit integration.
 *
 * @see P2-TS-06
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockFrom = vi.hoisted(() => vi.fn());
const mockGetSession = vi.hoisted(() => vi.fn());
const mockLogAuditEvent = vi.hoisted(() => vi.fn());
const mockWorkerFetch = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: mockFrom,
    auth: {
      getSession: mockGetSession,
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
    },
  },
}));

vi.mock('@/lib/auditLog', () => ({
  logAuditEvent: mockLogAuditEvent,
}));

vi.mock('@/lib/workerClient', () => ({ workerFetch: mockWorkerFetch }));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

describe('useOrganization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetSession.mockResolvedValue({
      data: { session: { user: { id: 'user-1' } } },
      error: null,
    });
  });

  function createWrapper() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    return ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children);
  }

  it('returns null organization when orgId is null', async () => {
    const { useOrganization } = await import('./useOrganization');
    const { result } = renderHook(() => useOrganization(null), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.organization).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('fetches organization by orgId', async () => {
    const mockOrg = { id: 'org-1', display_name: 'Test Corp', domain: 'test.com' };
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: mockOrg, error: null }),
        }),
      }),
    });

    const { useOrganization } = await import('./useOrganization');
    const { result } = renderHook(() => useOrganization('org-1'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.organization).toEqual(mockOrg);
  });

  it('fetches a foreign selected org through the platform-admin worker path', async () => {
    const mockOrg = { id: 'org-1', display_name: 'PlanBook Selected', domain: 'planbook.test' };
    mockWorkerFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ organization: mockOrg }),
    });

    const { useOrganization } = await import('./useOrganization');
    const { result } = renderHook(() => useOrganization('org-1', true), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.organization).toEqual(mockOrg);
    expect(mockWorkerFetch).toHaveBeenCalledWith('/api/admin/organizations/org-1', { method: 'GET' });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('sets error when fetch fails', async () => {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: null,
            error: { message: 'Not found' },
          }),
        }),
      }),
    });

    const { useOrganization } = await import('./useOrganization');
    const { result } = renderHook(() => useOrganization('org-1'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('Not found');
  });

  it('updateOrganization returns false when orgId is null', async () => {
    const { useOrganization } = await import('./useOrganization');
    const { result } = renderHook(() => useOrganization(null), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let updated: boolean = true;
    await act(async () => {
      updated = await result.current.updateOrganization({ display_name: 'New' });
    });

    expect(updated).toBe(false);
  });

  it('updateOrganization calls supabase update and logs audit event on success', async () => {
    const mockOrg = { id: 'org-1', display_name: 'Test Corp', domain: 'test.com' };

    // Initial fetch
    mockFrom.mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: mockOrg, error: null }),
        }),
      }),
    });

    const { useOrganization } = await import('./useOrganization');
    const { result } = renderHook(() => useOrganization('org-1'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Update call — Session 14: update().eq().select() chain for silent RLS failure detection
    mockFrom
      .mockReturnValueOnce({
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            select: vi.fn().mockResolvedValue({ data: [{ id: 'org-1' }], error: null }),
          }),
        }),
      })
      .mockReturnValueOnce({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { ...mockOrg, display_name: 'New Corp' },
              error: null,
            }),
          }),
        }),
      });

    let updated: boolean = false;
    await act(async () => {
      updated = await result.current.updateOrganization({ display_name: 'New Corp' });
    });

    expect(updated).toBe(true);
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ORG_UPDATED',
        targetId: 'org-1',
      }),
    );
  });

  it.each([
    ['logo_storage_path' as const, null, 'is'],
    ['banner_storage_path' as const, 'organizations/org-public/banner/old.png', 'eq'],
  ])('applies the organization media CAS for %s', async (field, expected, method) => {
    const mockOrg = { id: 'org-1', public_id: 'org-public', display_name: 'Test Corp', domain: 'test.com' };
    const chain = { eq: vi.fn(), is: vi.fn(), select: vi.fn() };
    chain.eq.mockReturnValue(chain);
    chain.is.mockReturnValue(chain);
    chain.select.mockResolvedValue({ data: [], error: null });
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: mockOrg, error: null }) }) }),
      update: vi.fn().mockReturnValue(chain),
    });
    const { useOrganization } = await import('./useOrganization');
    const { result } = renderHook(() => useOrganization('org-1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.organization?.id).toBe('org-1'));
    await act(async () => { await result.current.updateOrganization(
      { [field]: `organizations/org-public/${field.startsWith('logo') ? 'logo' : 'banner'}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png` },
      { field, expected },
    ); });
    expect(chain[method as 'is' | 'eq']).toHaveBeenCalledWith(field, expected);
  });

  // The media upload surface owns its own success message; without this the
  // user saw TWO toasts for one action ("Organization updated" plus "Logo
  // updated successfully"). PR #3033 review, pass 4.
  it.each([
    [undefined, 1],
    [{ silentSuccess: true }, 0],
  ])('suppresses the generic success toast when the caller owns the message (%o)', async (options, expectedToasts) => {
    const { toast } = await import('sonner');
    const mockOrg = { id: 'org-1', public_id: 'org-public', display_name: 'Test Corp' };
    const chain = { eq: vi.fn(), is: vi.fn(), select: vi.fn() };
    chain.eq.mockReturnValue(chain);
    chain.is.mockReturnValue(chain);
    chain.select.mockResolvedValue({ data: [{ id: 'org-1' }], error: null });
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: mockOrg, error: null }) }) }),
      update: vi.fn().mockReturnValue(chain),
    });
    const { useOrganization } = await import('./useOrganization');
    const { result } = renderHook(() => useOrganization('org-1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.organization?.id).toBe('org-1'));
    let updated = false;
    await act(async () => {
      updated = await result.current.updateOrganization({ display_name: 'New Corp' }, undefined, options);
    });
    expect(updated).toBe(true);
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(expectedToasts);
  });
});
