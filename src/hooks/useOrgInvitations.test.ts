/**
 * useOrgInvitations Hook Tests
 *
 * Prod evidence: 5 invitations ever, 3 confirmed EMAIL_SENT, 0 accepted, 0
 * MEMBER_JOINED audit events — and the inviting admin has NO surfaced status
 * for any of them today. `OrgProfilePage` / `MembersTable` show nothing
 * between "clicked Send" and a name appearing in the members list, so a
 * stuck invite (spam-filtered, ignored, or genuinely expired) is invisible
 * to the person who sent it. This hook is the read side of that fix: it
 * lists an org's non-accepted invitations and recomputes `pending` ->
 * `expired` the same way the worker's GET /api/invitations/:token preview
 * does (status column is never flipped to 'expired' at read time — see
 * services/worker/src/api/invitations.ts's isExpired()), so a stale
 * `status='pending'` row past its `expires_at` still displays as expired.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createQueryWrapper } from '@/tests/queryTestUtils';

const mockOrder = vi.hoisted(() => vi.fn());
const mockLimit = vi.hoisted(() => vi.fn());
const mockNeq = vi.hoisted(() => vi.fn());
const mockEq = vi.hoisted(() => vi.fn());
const mockSelect = vi.hoisted(() => vi.fn());
const mockFrom = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: mockFrom,
  },
}));

import { useOrgInvitations } from './useOrgInvitations';

describe('useOrgInvitations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockReturnValue({ select: mockSelect });
    mockSelect.mockReturnValue({ eq: mockEq });
    mockEq.mockReturnValue({ neq: mockNeq });
    mockNeq.mockReturnValue({ order: mockOrder });
    mockOrder.mockReturnValue({ limit: mockLimit });
  });

  it('returns empty invitations and stops loading when no orgId', async () => {
    const { result } = renderHook(() => useOrgInvitations(null), { wrapper: createQueryWrapper() });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.invitations).toEqual([]);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('never selects the raw single-use token column (§1.4 — secret must never reach the browser for display)', async () => {
    mockLimit.mockResolvedValue({ data: [], error: null });

    renderHook(() => useOrgInvitations('org-1'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(mockSelect).toHaveBeenCalled());
    const selectedColumns = mockSelect.mock.calls[0][0] as string;
    expect(selectedColumns).not.toMatch(/\btoken\b/);
  });

  it('excludes already-accepted invitations at the query layer', async () => {
    mockLimit.mockResolvedValue({ data: [], error: null });

    renderHook(() => useOrgInvitations('org-1'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(mockEq).toHaveBeenCalledWith('org_id', 'org-1'));
    expect(mockNeq).toHaveBeenCalledWith('status', 'accepted');
  });

  it('recomputes a stale status=pending row past its expires_at as expired', async () => {
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    mockLimit.mockResolvedValue({
      data: [
        {
          id: 'inv-1',
          email: 'alex@arkova.ai',
          role: 'INDIVIDUAL',
          status: 'pending',
          created_at: '2026-08-03T15:31:18.375304+00:00',
          expires_at: pastExpiry,
          accepted_at: null,
        },
      ],
      error: null,
    });

    const { result } = renderHook(() => useOrgInvitations('org-1'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.invitations).toHaveLength(1));
    expect(result.current.invitations[0]).toMatchObject({
      id: 'inv-1',
      email: 'alex@arkova.ai',
      displayStatus: 'expired',
    });
  });

  it('keeps a genuinely still-pending row as pending', async () => {
    const futureExpiry = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString();
    mockLimit.mockResolvedValue({
      data: [
        {
          id: 'inv-2',
          email: 'newperson@example.com',
          role: 'INDIVIDUAL',
          status: 'pending',
          created_at: new Date().toISOString(),
          expires_at: futureExpiry,
          accepted_at: null,
        },
      ],
      error: null,
    });

    const { result } = renderHook(() => useOrgInvitations('org-1'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.invitations).toHaveLength(1));
    expect(result.current.invitations[0].displayStatus).toBe('pending');
  });

  it('surfaces a query error instead of silently returning an empty list', async () => {
    mockLimit.mockResolvedValue({ data: null, error: { message: 'permission denied' } });

    const { result } = renderHook(() => useOrgInvitations('org-1'), { wrapper: createQueryWrapper() });

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.error).toContain('permission denied');
    expect(result.current.invitations).toEqual([]);
  });
});
