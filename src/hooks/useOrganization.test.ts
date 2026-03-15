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

const mockFrom = vi.hoisted(() => vi.fn());
const mockGetSession = vi.hoisted(() => vi.fn());
const mockLogAuditEvent = vi.hoisted(() => vi.fn());

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

  it('returns null organization when orgId is null', async () => {
    const { useOrganization } = await import('./useOrganization');
    const { result } = renderHook(() => useOrganization(null));

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
    const { result } = renderHook(() => useOrganization('org-1'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.organization).toEqual(mockOrg);
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
    const { result } = renderHook(() => useOrganization('org-1'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('Not found');
  });

  it('updateOrganization returns false when orgId is null', async () => {
    const { useOrganization } = await import('./useOrganization');
    const { result } = renderHook(() => useOrganization(null));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let updated: boolean = true;
    await act(async () => {
      updated = await result.current.updateOrganization({ display_name: 'New' });
    });

    expect(updated).toBe(false);
    expect(result.current.error).toBe('No organization');
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
    const { result } = renderHook(() => useOrganization('org-1'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Update call
    mockFrom
      .mockReturnValueOnce({
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
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
});
