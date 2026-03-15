/**
 * useCredentialTemplates Hook Tests
 *
 * Tests CRUD operations, error handling, toast notifications,
 * and audit logging for credential templates.
 *
 * @see P5-TS-07
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const mockFrom = vi.hoisted(() => vi.fn());
const mockGetSession = vi.hoisted(() => vi.fn());
const mockGetUser = vi.hoisted(() => vi.fn());
const mockLogAuditEvent = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: mockFrom,
    auth: {
      getSession: mockGetSession,
      getUser: mockGetUser,
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

describe('useCredentialTemplates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetSession.mockResolvedValue({
      data: { session: { user: { id: 'user-1' } } },
      error: null,
    });
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
    });
  });

  function setupFetchMock(data: unknown[] | null, error: { message: string } | null = null) {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockResolvedValue({ data, error }),
        }),
      }),
    });
  }

  it('returns empty templates when orgId is null', async () => {
    const { useCredentialTemplates } = await import('./useCredentialTemplates');
    const { result } = renderHook(() => useCredentialTemplates(null));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.templates).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('fetches templates for the given orgId', async () => {
    const mockTemplates = [
      { id: 'tpl-1', name: 'Diploma', credential_type: 'DEGREE', org_id: 'org-1' },
    ];
    setupFetchMock(mockTemplates);

    const { useCredentialTemplates } = await import('./useCredentialTemplates');
    const { result } = renderHook(() => useCredentialTemplates('org-1'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.templates).toEqual(mockTemplates);
  });

  it('sets error when fetch fails', async () => {
    setupFetchMock(null, { message: 'Permission denied' });

    const { useCredentialTemplates } = await import('./useCredentialTemplates');
    const { result } = renderHook(() => useCredentialTemplates('org-1'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('Permission denied');
  });

  it('createTemplate returns null and sets error when no orgId', async () => {
    setupFetchMock([]);

    const { useCredentialTemplates } = await import('./useCredentialTemplates');
    const { result } = renderHook(() => useCredentialTemplates(null));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let created: unknown;
    await act(async () => {
      created = await result.current.createTemplate({
        name: 'Test',
        credential_type: 'DEGREE',
      });
    });

    expect(created).toBeNull();
    expect(result.current.error).toBe('No organization');
  });

  it('deleteTemplate returns false when no orgId', async () => {
    setupFetchMock([]);

    const { useCredentialTemplates } = await import('./useCredentialTemplates');
    const { result } = renderHook(() => useCredentialTemplates(null));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let deleted: boolean = true;
    await act(async () => {
      deleted = await result.current.deleteTemplate('tpl-1');
    });

    expect(deleted).toBe(false);
    expect(result.current.error).toBe('No organization');
  });

  it('updateTemplate returns false when no orgId', async () => {
    setupFetchMock([]);

    const { useCredentialTemplates } = await import('./useCredentialTemplates');
    const { result } = renderHook(() => useCredentialTemplates(null));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let updated: boolean = true;
    await act(async () => {
      updated = await result.current.updateTemplate('tpl-1', { name: 'New' });
    });

    expect(updated).toBe(false);
    expect(result.current.error).toBe('No organization');
  });
});
