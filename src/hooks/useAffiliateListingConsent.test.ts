/**
 * useAffiliateListingConsent Hook Tests (SCRUM-3864)
 *
 * Mirrors the mocking pattern in useOrganization.test.ts. Covers: the happy
 * path, Zod-schema rejection before any network call, the "RLS/trigger
 * silently returns zero rows" case (PostgREST reports this as
 * `{ data: [], error: null }`, not an error — checking only `error` would
 * misreport a 42501 rejection as success), a genuine Postgres error, and
 * that the busy flag tracks the in-flight child org id.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const mockFrom = vi.hoisted(() => vi.fn());
const mockLogAuditEvent = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: { from: mockFrom },
}));

vi.mock('@/lib/auditLog', () => ({
  logAuditEvent: mockLogAuditEvent,
}));

vi.mock('sonner', () => ({ toast: { error: mockToastError, success: vi.fn() } }));

describe('useAffiliateListingConsent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets sub_org_listing_parent_optin on the CHILD org row and returns the landed value', async () => {
    mockFrom.mockReturnValue({
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          select: vi.fn().mockResolvedValue({
            data: [{ id: 'child-1', sub_org_listing_parent_optin: true }],
            error: null,
          }),
        }),
      }),
    });

    const { useAffiliateListingConsent } = await import('./useAffiliateListingConsent');
    const { result } = renderHook(() => useAffiliateListingConsent());

    let landed: boolean | null = null;
    await act(async () => {
      landed = await result.current.setParentListingOptin('child-1', true);
    });

    expect(landed).toBe(true);
    expect(mockFrom).toHaveBeenCalledWith('organizations');
    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'SUB_ORG_LISTING_CONSENT_CHANGED',
        eventCategory: 'ORG',
        targetId: 'child-1',
        orgId: 'child-1',
      }),
    );
  });

  it('returns null and does not call supabase when the payload fails Zod validation', async () => {
    const { useAffiliateListingConsent } = await import('./useAffiliateListingConsent');
    const { result } = renderHook(() => useAffiliateListingConsent());

    let landed: boolean | null = true as unknown as null;
    await act(async () => {
      // @ts-expect-error — deliberately wrong type to prove the schema gate fires
      landed = await result.current.setParentListingOptin('child-1', 'yes');
    });

    expect(landed).toBeNull();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('treats a zero-row response (RLS/trigger 42501 masked by PostgREST) as a failure, not a success', async () => {
    mockFrom.mockReturnValue({
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          select: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
      }),
    });

    const { useAffiliateListingConsent } = await import('./useAffiliateListingConsent');
    const { result } = renderHook(() => useAffiliateListingConsent());

    let landed: boolean | null = true;
    await act(async () => {
      landed = await result.current.setParentListingOptin('child-1', true);
    });

    expect(landed).toBeNull();
    expect(mockToastError).toHaveBeenCalled();
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  it('surfaces a genuine Postgres error as a failure', async () => {
    mockFrom.mockReturnValue({
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          select: vi.fn().mockResolvedValue({
            data: null,
            error: { message: 'insufficient_privilege', code: '42501' },
          }),
        }),
      }),
    });

    const { useAffiliateListingConsent } = await import('./useAffiliateListingConsent');
    const { result } = renderHook(() => useAffiliateListingConsent());

    let landed: boolean | null = true;
    await act(async () => {
      landed = await result.current.setParentListingOptin('child-1', true);
    });

    expect(landed).toBeNull();
    expect(mockToastError).toHaveBeenCalled();
  });

  it('tracks busyChildOrgId for the in-flight child and clears it after settling', async () => {
    let resolveUpdate!: (v: { data: unknown; error: null }) => void;
    mockFrom.mockReturnValue({
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          select: vi.fn(() => new Promise((resolve) => { resolveUpdate = resolve; })),
        }),
      }),
    });

    const { useAffiliateListingConsent } = await import('./useAffiliateListingConsent');
    const { result } = renderHook(() => useAffiliateListingConsent());

    expect(result.current.busyChildOrgId).toBeNull();

    let pending!: Promise<boolean | null>;
    act(() => {
      pending = result.current.setParentListingOptin('child-9', true);
    });

    await waitFor(() => {
      expect(result.current.busyChildOrgId).toBe('child-9');
    });

    await act(async () => {
      resolveUpdate({ data: [{ id: 'child-9', sub_org_listing_parent_optin: true }], error: null });
      await pending;
    });

    expect(result.current.busyChildOrgId).toBeNull();
  });
});
