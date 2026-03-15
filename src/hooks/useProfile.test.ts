/**
 * useProfile Hook Tests
 *
 * Tests profile fetching, destination routing logic,
 * update functionality, and ProfileProvider context.
 *
 * @see P2-TS-05
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const mockFrom = vi.hoisted(() => vi.fn());
const mockGetSession = vi.hoisted(() => vi.fn());
const mockOnAuthStateChange = vi.hoisted(() => vi.fn());
const mockLogAuditEvent = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: mockFrom,
    auth: {
      getSession: mockGetSession,
      onAuthStateChange: mockOnAuthStateChange,
    },
  },
}));

vi.mock('@/lib/auditLog', () => ({
  logAuditEvent: mockLogAuditEvent,
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

describe('useProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockOnAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe: vi.fn() } },
    });
  });

  function setupSession(user: { id: string; email: string } | null) {
    mockGetSession.mockResolvedValue({
      data: { session: user ? { user } : null },
      error: null,
    });
  }

  function setupProfileFetch(profile: Record<string, unknown> | null, error: { message: string } | null = null) {
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: profile, error }),
        }),
      }),
    });
  }

  async function renderWithProvider() {
    const { ProfileProvider, useProfile } = await import('./useProfile');
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(ProfileProvider, null, children);
    return renderHook(() => useProfile(), { wrapper });
  }

  it('throws when used outside ProfileProvider', async () => {
    const { useProfile } = await import('./useProfile');

    expect(() => {
      renderHook(() => useProfile());
    }).toThrow('useProfile must be used within a ProfileProvider');
  });

  it('returns null profile and /auth destination when not authenticated', async () => {
    setupSession(null);
    setupProfileFetch(null);

    const { result } = await renderWithProvider();

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.profile).toBeNull();
    expect(result.current.destination).toBe('/auth');
  });

  it('routes to /onboarding/role when profile has no role', async () => {
    setupSession({ id: 'user-1', email: 'test@test.com' });
    setupProfileFetch({
      id: 'user-1',
      role: null,
      org_id: null,
      requires_manual_review: false,
    });

    const { result } = await renderWithProvider();

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.destination).toBe('/onboarding/role');
  });

  it('routes to /onboarding/org for ORG_ADMIN without org', async () => {
    setupSession({ id: 'user-1', email: 'test@test.com' });
    setupProfileFetch({
      id: 'user-1',
      role: 'ORG_ADMIN',
      org_id: null,
      requires_manual_review: false,
    });

    const { result } = await renderWithProvider();

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.destination).toBe('/onboarding/org');
  });

  it('routes to /review-pending when manual review required', async () => {
    setupSession({ id: 'user-1', email: 'test@test.com' });
    setupProfileFetch({
      id: 'user-1',
      role: 'INDIVIDUAL',
      org_id: null,
      requires_manual_review: true,
    });

    const { result } = await renderWithProvider();

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.destination).toBe('/review-pending');
  });

  it('routes to /vault for INDIVIDUAL users', async () => {
    setupSession({ id: 'user-1', email: 'test@test.com' });
    setupProfileFetch({
      id: 'user-1',
      role: 'INDIVIDUAL',
      org_id: null,
      requires_manual_review: false,
    });

    const { result } = await renderWithProvider();

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.destination).toBe('/vault');
  });

  it('routes to /dashboard for ORG_ADMIN with org', async () => {
    setupSession({ id: 'user-1', email: 'test@test.com' });
    setupProfileFetch({
      id: 'user-1',
      role: 'ORG_ADMIN',
      org_id: 'org-1',
      requires_manual_review: false,
    });

    const { result } = await renderWithProvider();

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.destination).toBe('/dashboard');
  });

  it('sets error when profile fetch fails', async () => {
    setupSession({ id: 'user-1', email: 'test@test.com' });
    setupProfileFetch(null, { message: 'Row not found' });

    const { result } = await renderWithProvider();

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('Row not found');
  });

  it('updateProfile returns false when not authenticated', async () => {
    setupSession(null);
    setupProfileFetch(null);

    const { result } = await renderWithProvider();

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let updated: boolean = true;
    await act(async () => {
      updated = await result.current.updateProfile({ full_name: 'New Name' });
    });

    expect(updated).toBe(false);
    expect(result.current.error).toBe('Not authenticated');
  });
});
