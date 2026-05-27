/* eslint-disable arkova/require-error-code-assertion -- Error shape varies by Supabase operation; specific codes tested in RLS integration suite */
/**
 * useInviteMember Hook Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist the mock function
const mockRpc = vi.hoisted(() => vi.fn());
const mockGetSession = vi.hoisted(() => vi.fn());
const mockResolveSafeWorkerEndpoint = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: mockRpc,
    auth: {
      getSession: mockGetSession,
    },
  },
}));

vi.mock('@/lib/workerUrlSafety', () => ({
  resolveSafeWorkerEndpoint: mockResolveSafeWorkerEndpoint,
}));

// Mock fetch for worker email endpoint
const mockFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', mockFetch);

// Import after mocks
import { renderHook, act } from '@testing-library/react';
import { useInviteMember } from './useInviteMember';

const defaultOptions = {
  email: 'test@example.com',
  role: 'INDIVIDUAL' as const,
  orgId: '11111111-1111-4111-8111-111111111111',
  orgName: 'Test Org',
};

describe('useInviteMember', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSafeWorkerEndpoint.mockReturnValue(new URL('http://localhost:3001/api/send-invitation-email'));
    mockGetSession.mockResolvedValue({ data: { session: { access_token: 'test-token' } } });
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ sent: true }) });
  });

  it('should successfully invite a member', async () => {
    mockRpc.mockResolvedValue({ data: 'invite-uuid', error: null });

    const { result } = renderHook(() => useInviteMember());

    let success: boolean;
    await act(async () => {
      success = await result.current.inviteMember(defaultOptions);
    });

    expect(success!).toBe(true);
    expect(mockRpc).toHaveBeenCalledWith('invite_member', {
      invitee_email: 'test@example.com',
      invitee_role: 'INDIVIDUAL',
      target_org_id: '11111111-1111-4111-8111-111111111111',
    });
    expect(result.current.error).toBeNull();
  });

  it('should send invitation email after successful RPC', async () => {
    mockRpc.mockResolvedValue({ data: 'invite-uuid', error: null });

    const { result } = renderHook(() => useInviteMember());

    await act(async () => {
      await result.current.inviteMember({ ...defaultOptions, inviterName: 'Carson' });
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/send-invitation-email'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );
  });

  it('should handle already a member error', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'User is already a member of this organization' },
    });

    const { result } = renderHook(() => useInviteMember());

    let success: boolean;
    await act(async () => {
      success = await result.current.inviteMember(defaultOptions);
    });

    expect(success!).toBe(false);
    expect(result.current.error).toContain('already a member');
  });

  it('should handle insufficient privilege error', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'insufficient_privilege: Only org admins can invite' },
    });

    const { result } = renderHook(() => useInviteMember());

    let success: boolean;
    await act(async () => {
      success = await result.current.inviteMember({ ...defaultOptions, role: 'ORG_ADMIN' });
    });

    expect(success!).toBe(false);
    expect(result.current.error).toContain('permission');
  });

  it('should handle an invalid email error from the invite RPC', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'invalid email format' },
    });

    const { result } = renderHook(() => useInviteMember());

    let success: boolean;
    await act(async () => {
      success = await result.current.inviteMember({ ...defaultOptions, email: 'valid@example.com' });
    });

    expect(success!).toBe(false);
    expect(result.current.error).toContain('valid email');
  });

  it('should reject an invalid invite payload before creating the invitation record', async () => {
    const { result } = renderHook(() => useInviteMember());

    let success: boolean;
    await act(async () => {
      success = await result.current.inviteMember({ ...defaultOptions, email: 'bad-email' });
    });

    expect(success!).toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.error).toContain('valid email');
  });

  it('should reject an invalid organization id before creating the invitation record', async () => {
    const { result } = renderHook(() => useInviteMember());

    let success: boolean;
    await act(async () => {
      success = await result.current.inviteMember({ ...defaultOptions, orgId: 'org-123' });
    });

    expect(success!).toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.error).toContain('valid organization');
  });

  it('should not create an invitation or read the bearer token when the worker URL is unsafe', async () => {
    mockResolveSafeWorkerEndpoint.mockImplementation(() => {
      throw new Error('Worker endpoint must use HTTPS outside localhost.');
    });

    const { result } = renderHook(() => useInviteMember());

    let success: boolean;
    await act(async () => {
      success = await result.current.inviteMember(defaultOptions);
    });

    expect(success!).toBe(false);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.error).toContain('HTTPS outside localhost');
  });

  it('should fail when the invitation email endpoint rejects after RPC success', async () => {
    mockRpc.mockResolvedValue({ data: 'invite-uuid', error: null });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: { code: 'forbidden' } }) });

    const { result } = renderHook(() => useInviteMember());

    let success: boolean;
    await act(async () => {
      success = await result.current.inviteMember(defaultOptions);
    });

    expect(success!).toBe(false);
    expect(result.current.error).toContain('email could not be sent');
  });

  it('should clear error when clearError is called', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'Some error' },
    });

    const { result } = renderHook(() => useInviteMember());

    await act(async () => {
      await result.current.inviteMember(defaultOptions);
    });

    expect(result.current.error).not.toBeNull();

    act(() => {
      result.current.clearError();
    });

    expect(result.current.error).toBeNull();
  });
});
