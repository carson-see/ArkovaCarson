/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping */
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
import { createQueryWrapper } from '@/tests/queryTestUtils';

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
    const { result } = renderHook(() => useCredentialTemplates(null), { wrapper: createQueryWrapper() });

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
    const { result } = renderHook(() => useCredentialTemplates('org-1'), { wrapper: createQueryWrapper() });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.templates).toEqual(mockTemplates);
  });

  it('sets error when fetch fails', async () => {
    setupFetchMock(null, { message: 'Permission denied' });

    const { useCredentialTemplates } = await import('./useCredentialTemplates');
    const { result } = renderHook(() => useCredentialTemplates('org-1'), { wrapper: createQueryWrapper() });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('Permission denied');
  });

  it('createTemplate returns null when no orgId', async () => {
    setupFetchMock([]);

    const { useCredentialTemplates } = await import('./useCredentialTemplates');
    const { result } = renderHook(() => useCredentialTemplates(null), { wrapper: createQueryWrapper() });

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
  });

  it('deleteTemplate returns false when no orgId', async () => {
    setupFetchMock([]);

    const { useCredentialTemplates } = await import('./useCredentialTemplates');
    const { result } = renderHook(() => useCredentialTemplates(null), { wrapper: createQueryWrapper() });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let deleted: boolean = true;
    await act(async () => {
      deleted = await result.current.deleteTemplate('tpl-1');
    });

    expect(deleted).toBe(false);
  });

  it('updateTemplate returns false when no orgId', async () => {
    setupFetchMock([]);

    const { useCredentialTemplates } = await import('./useCredentialTemplates');
    const { result } = renderHook(() => useCredentialTemplates(null), { wrapper: createQueryWrapper() });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let updated: boolean = true;
    await act(async () => {
      updated = await result.current.updateTemplate('tpl-1', { name: 'New' });
    });

    expect(updated).toBe(false);
  });

  // BUG (2026-08-03 bug sprint): credential_templates_update / _delete RLS
  // policies require role='ORG_ADMIN' (supabase/migrations/00000000000000_baseline_at_main_HEAD.sql),
  // but credential_templates_select does NOT — any org member (including a
  // non-admin ORG_MEMBER) can reach CredentialTemplatesPage and see working
  // Edit/Delete controls (CredentialTemplatesManager.tsx renders them
  // unconditionally). When a non-admin's write hits RLS, Postgres reports
  // zero rows matched, not an error — so without a `.select()` zero-row
  // check, the old code took the success branch: audit-logged a change that
  // never happened, toasted success, and optimistically rewrote the cache.
  it('updateTemplate returns false and does not log/toast success when RLS silently matches zero rows', async () => {
    setupFetchMock([{ id: 'tpl-1', name: 'Diploma', credential_type: 'DEGREE', org_id: 'org-1' }]);

    const { useCredentialTemplates } = await import('./useCredentialTemplates');
    const { result } = renderHook(() => useCredentialTemplates('org-1'), { wrapper: createQueryWrapper() });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const mockSelect = vi.fn().mockResolvedValue({ data: [], error: null });
    const mockEqOrg = vi.fn().mockReturnValue({ select: mockSelect });
    const mockEqId = vi.fn().mockReturnValue({ eq: mockEqOrg });
    mockFrom.mockReturnValueOnce({ update: vi.fn().mockReturnValue({ eq: mockEqId }) });

    const { toast } = await import('sonner');
    let updated: boolean = true;
    await act(async () => {
      updated = await result.current.updateTemplate('tpl-1', { name: 'New' });
    });

    expect(updated).toBe(false);
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  it('updateTemplate returns true and logs the audit event when the update affects a row', async () => {
    setupFetchMock([{ id: 'tpl-1', name: 'Diploma', credential_type: 'DEGREE', org_id: 'org-1' }]);

    const { useCredentialTemplates } = await import('./useCredentialTemplates');
    const { result } = renderHook(() => useCredentialTemplates('org-1'), { wrapper: createQueryWrapper() });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const mockSelect = vi.fn().mockResolvedValue({ data: [{ id: 'tpl-1' }], error: null });
    const mockEqOrg = vi.fn().mockReturnValue({ select: mockSelect });
    const mockEqId = vi.fn().mockReturnValue({ eq: mockEqOrg });
    mockFrom.mockReturnValueOnce({ update: vi.fn().mockReturnValue({ eq: mockEqId }) });

    let updated: boolean = false;
    await act(async () => {
      updated = await result.current.updateTemplate('tpl-1', { name: 'New' });
    });

    expect(updated).toBe(true);
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'TEMPLATE_UPDATED', targetId: 'tpl-1' }),
    );
  });

  it('deleteTemplate returns false and does not log/toast success when RLS silently matches zero rows', async () => {
    setupFetchMock([{ id: 'tpl-1', name: 'Diploma', credential_type: 'DEGREE', org_id: 'org-1' }]);

    const { useCredentialTemplates } = await import('./useCredentialTemplates');
    const { result } = renderHook(() => useCredentialTemplates('org-1'), { wrapper: createQueryWrapper() });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const mockSelect = vi.fn().mockResolvedValue({ data: [], error: null });
    const mockEqOrg = vi.fn().mockReturnValue({ select: mockSelect });
    const mockEqId = vi.fn().mockReturnValue({ eq: mockEqOrg });
    mockFrom.mockReturnValueOnce({ delete: vi.fn().mockReturnValue({ eq: mockEqId }) });

    const { toast } = await import('sonner');
    let deleted: boolean = true;
    await act(async () => {
      deleted = await result.current.deleteTemplate('tpl-1');
    });

    expect(deleted).toBe(false);
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  it('deleteTemplate returns true and logs the audit event when the delete affects a row', async () => {
    setupFetchMock([{ id: 'tpl-1', name: 'Diploma', credential_type: 'DEGREE', org_id: 'org-1' }]);

    const { useCredentialTemplates } = await import('./useCredentialTemplates');
    const { result } = renderHook(() => useCredentialTemplates('org-1'), { wrapper: createQueryWrapper() });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const mockSelect = vi.fn().mockResolvedValue({ data: [{ id: 'tpl-1' }], error: null });
    const mockEqOrg = vi.fn().mockReturnValue({ select: mockSelect });
    const mockEqId = vi.fn().mockReturnValue({ eq: mockEqOrg });
    mockFrom.mockReturnValueOnce({ delete: vi.fn().mockReturnValue({ eq: mockEqId }) });

    let deleted: boolean = false;
    await act(async () => {
      deleted = await result.current.deleteTemplate('tpl-1');
    });

    expect(deleted).toBe(true);
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'TEMPLATE_DELETED', targetId: 'tpl-1' }),
    );
  });
});
