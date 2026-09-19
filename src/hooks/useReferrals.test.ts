/**
 * useReferrals — SCRUM-5024.
 *
 * The property that matters most here is the one a `?? []` would destroy: a
 * failed read must set `error` and must NOT report an empty referral list as
 * though it were an answer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom, mockRpc } = vi.hoisted(() => ({ mockFrom: vi.fn(), mockRpc: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { from: mockFrom, rpc: mockRpc } }));

import { renderHook, waitFor, act } from '@testing-library/react';
import { useReferrals, buildShareUrl } from './useReferrals';

function stubCode(result: { data: unknown; error: unknown }) {
  mockFrom.mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = () => Promise.resolve(result);
    return chain;
  });
}

const ROWS = [
  {
    organization_public_id: 'org_referred_1',
    display_name: 'Referred One',
    referred_at: '2026-09-01T10:00:00.000Z',
    verification_status: 'VERIFIED',
  },
  {
    organization_public_id: null,
    display_name: 'Legacy Org',
    referred_at: '2026-08-20T09:00:00.000Z',
    verification_status: 'UNVERIFIED',
  },
];

describe('useReferrals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('loads the active code and the referred organizations', async () => {
    stubCode({ data: { code: 'ABCD2345' }, error: null });
    mockRpc.mockResolvedValue({ data: ROWS, error: null });

    const { result } = renderHook(() => useReferrals('org-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeNull();
    expect(result.current.code).toBe('ABCD2345');
    expect(result.current.referred).toHaveLength(2);
    expect(mockRpc).toHaveBeenCalledWith('get_org_referrals', { p_org_id: 'org-1' });
  });

  it('omits organizationPublicId rather than carrying a null through', async () => {
    stubCode({ data: { code: 'ABCD2345' }, error: null });
    mockRpc.mockResolvedValue({ data: ROWS, error: null });

    const { result } = renderHook(() => useReferrals('org-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect('organizationPublicId' in result.current.referred[1]).toBe(false);
  });

  it('a failed referral read sets error — it does NOT report an empty list as an answer', async () => {
    stubCode({ data: { code: 'ABCD2345' }, error: null });
    mockRpc.mockResolvedValue({ data: null, error: { message: 'statement timeout' } });

    const { result } = renderHook(() => useReferrals('org-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('statement timeout');
    expect(result.current.referred).toEqual([]);
    // The panel branches on `error` first, so "no referrals" is never shown here.
  });

  it('a failed code read sets error too', async () => {
    stubCode({ data: null, error: { message: 'permission denied' } });

    const { result } = renderHook(() => useReferrals('org-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('permission denied');
    expect(result.current.code).toBeNull();
  });

  it('reads nothing at all without an organization', async () => {
    const { result } = renderHook(() => useReferrals(null));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('never mints during load — only mint() calls the RPC', async () => {
    stubCode({ data: null, error: null });
    mockRpc.mockResolvedValue({ data: [], error: null });

    const { result } = renderHook(() => useReferrals('org-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockRpc.mock.calls.map((c) => c[0])).not.toContain('ensure_org_referral_code');

    mockRpc.mockResolvedValue({ data: 'PQRS6789', error: null });
    await act(async () => {
      await result.current.mint();
    });

    expect(mockRpc).toHaveBeenCalledWith('ensure_org_referral_code', { p_org_id: 'org-1' });
    expect(result.current.code).toBe('PQRS6789');
    expect(result.current.mintError).toBeNull();
  });

  it('a failed mint is surfaced, not swallowed', async () => {
    stubCode({ data: null, error: null });
    mockRpc.mockResolvedValue({ data: [], error: null });

    const { result } = renderHook(() => useReferrals('org-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockRpc.mockResolvedValue({ data: null, error: { message: 'Not authorized' } });
    await act(async () => {
      await result.current.mint();
    });

    expect(result.current.mintError).toBe('Not authorized');
    expect(result.current.code).toBeNull();
  });

  it('a mint that returns no code is an error, not a silent success', async () => {
    stubCode({ data: null, error: null });
    mockRpc.mockResolvedValue({ data: [], error: null });

    const { result } = renderHook(() => useReferrals('org-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockRpc.mockResolvedValue({ data: null, error: null });
    await act(async () => {
      await result.current.mint();
    });

    expect(result.current.mintError).toMatch(/did not return a referral code/i);
  });

  it('buildShareUrl encodes the code and tolerates a trailing slash on the origin', () => {
    expect(buildShareUrl('ABCD2345', 'https://app.arkova.ai/')).toBe(
      'https://app.arkova.ai/signup?ref=ABCD2345',
    );
  });
});
