/**
 * useAcceptInvite Hook Tests (SCRUM-3012)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetSession = vi.hoisted(() => vi.fn());
const mockResolveSafeWorkerEndpoint = vi.hoisted(() => vi.fn());
const mockResolveWorkerBaseUrl = vi.hoisted(() => vi.fn());
const mockFetch = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: mockGetSession } },
}));

vi.mock('@/lib/workerUrlSafety', () => ({
  resolveSafeWorkerEndpoint: mockResolveSafeWorkerEndpoint,
  resolveWorkerBaseUrl: mockResolveWorkerBaseUrl,
}));

vi.stubGlobal('fetch', mockFetch);

import { renderHook, act } from '@testing-library/react';
import { useAcceptInvite } from './useAcceptInvite';

const PREVIEW = {
  orgName: 'Example Org',
  email: 'invitee@example.com',
  role: 'INDIVIDUAL' as const,
  expired: false,
  alreadyUsed: false,
};

describe('useAcceptInvite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveWorkerBaseUrl.mockReturnValue('http://localhost:3001');
    mockResolveSafeWorkerEndpoint.mockImplementation((base: string, path: string) => new URL(path, base));
    mockGetSession.mockResolvedValue({ data: { session: null } });
  });

  describe('loadPreview', () => {
    it('fetches and stores a valid preview', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => PREVIEW });
      const { result } = renderHook(() => useAcceptInvite());

      await act(async () => {
        await result.current.loadPreview('good-token');
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/invitations/good-token'),
      );
      expect(result.current.preview).toEqual(PREVIEW);
      expect(result.current.previewError).toBeNull();
    });

    it('surfaces the worker error code + message on a non-OK response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        json: async () => ({ error: { code: 'expired', message: 'This invitation has expired.' } }),
      });
      const { result } = renderHook(() => useAcceptInvite());

      await act(async () => {
        await result.current.loadPreview('expired-token').catch(() => {});
      });

      // The InviteAcceptError must carry the worker's real code/message through
      // (transformation: raw fetch Response -> typed, code-bearing error)...
      expect(result.current.previewError?.code).toBe('expired');
      expect(result.current.previewError?.message).toBe('This invitation has expired.');
      // ...and a rejected preview must never populate `preview` or leave the
      // hook stuck in a loading state — both derived, not mirrored, from the mock.
      expect(result.current.preview).toBeNull();
      expect(result.current.previewLoading).toBe(false);
    });

    it('falls back to a generic error when the worker endpoint is unsafe', async () => {
      mockResolveSafeWorkerEndpoint.mockImplementation(() => {
        throw new Error('Worker endpoint must use HTTPS outside localhost.');
      });
      const { result } = renderHook(() => useAcceptInvite());

      await act(async () => {
        await result.current.loadPreview('good-token').catch(() => {});
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.current.previewError).not.toBeNull();
    });

    // Same root cause as useInviteMember: VITE_WORKER_URL unset in prod must
    // fail loudly, not silently fall back to localhost:3001.
    it('falls back to a generic error when the worker URL cannot be resolved (VITE_WORKER_URL unset in prod)', async () => {
      mockResolveWorkerBaseUrl.mockImplementation(() => {
        throw new Error('Worker URL is not configured for this production build (VITE_WORKER_URL is unset).');
      });
      const { result } = renderHook(() => useAcceptInvite());

      await act(async () => {
        await result.current.loadPreview('good-token').catch(() => {});
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.current.previewError).not.toBeNull();
    });
  });

  describe('acceptInvitation', () => {
    it('POSTs without an Authorization header when there is no session (new-account path)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, orgId: 'org-1', orgName: 'Example Org', verificationRequired: true, verificationEmailSent: true }),
      });
      const { result } = renderHook(() => useAcceptInvite());

      await act(async () => {
        await result.current.acceptInvitation({ token: 't', password: 'longenough' });
      });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body).toEqual({ token: 't', password: 'longenough' });
    });

    it('POSTs with the bearer token when a session exists (join path)', async () => {
      mockGetSession.mockResolvedValue({ data: { session: { access_token: 'session-token' } } });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, orgId: 'org-1', orgName: 'Example Org', verificationRequired: false, verificationEmailSent: false }),
      });
      const { result } = renderHook(() => useAcceptInvite());

      await act(async () => {
        await result.current.acceptInvitation({ token: 't' });
      });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer session-token');
    });

    it('surfaces account_exists so the caller can redirect to sign-in', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        json: async () => ({
          error: { code: 'account_exists', message: 'An account with this email already exists. Sign in to accept this invitation.' },
        }),
      });
      const { result } = renderHook(() => useAcceptInvite());

      await act(async () => {
        await result.current.acceptInvitation({ token: 't', password: 'longenough' }).catch(() => {});
      });

      expect(result.current.acceptError?.code).toBe('account_exists');
    });
  });
});
