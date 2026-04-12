/* eslint-disable arkova/no-mock-echo -- Integration test: verifies data flows through hook/component to rendered output */
/**
 * useMyCredentials Hook Tests
 *
 * Tests credential fetching via get_my_credentials RPC.
 *
 * @see UF-03
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createQueryWrapper } from '@/tests/queryTestUtils';

const mockRpc = vi.hoisted(() => vi.fn());
const mockGetSession = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: mockRpc,
    auth: {
      getSession: mockGetSession,
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
    },
  },
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

describe('useMyCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetSession.mockResolvedValue({
      data: { session: { user: { id: 'user-1', email: 'test@test.com' } } },
      error: null,
    });
  });

  it('returns empty credentials when user is not authenticated', async () => {
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });

    const { useMyCredentials } = await import('./useMyCredentials');
    const { result } = renderHook(() => useMyCredentials(), { wrapper: createQueryWrapper() });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.credentials).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('fetches and maps credentials from RPC', async () => {
    const mockData = [
      {
        recipient_id: 'rec-1',
        anchor_id: 'anc-1',
        claimed_at: '2026-03-16T00:00:00Z',
        recipient_created_at: '2026-03-15T00:00:00Z',
        public_id: 'pub-1',
        filename: 'diploma.pdf',
        fingerprint: 'abc123',
        status: 'SECURED',
        credential_type: 'DEGREE',
        metadata: { institution: 'MIT' },
        issued_at: '2026-01-01T00:00:00Z',
        expires_at: null,
        created_at: '2026-03-15T00:00:00Z',
        org_name: 'MIT',
        org_id: 'org-1',
      },
    ];

    mockRpc.mockResolvedValue({ data: mockData, error: null });

    const { useMyCredentials } = await import('./useMyCredentials');
    const { result } = renderHook(() => useMyCredentials(), { wrapper: createQueryWrapper() });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.credentials).toHaveLength(1);
    expect(result.current.credentials[0]).toEqual({
      recipientId: 'rec-1',
      anchorId: 'anc-1',
      claimedAt: '2026-03-16T00:00:00Z',
      recipientCreatedAt: '2026-03-15T00:00:00Z',
      publicId: 'pub-1',
      filename: 'diploma.pdf',
      fingerprint: 'abc123',
      status: 'SECURED',
      credentialType: 'DEGREE',
      metadata: { institution: 'MIT' },
      issuedAt: '2026-01-01T00:00:00Z',
      expiresAt: null,
      createdAt: '2026-03-15T00:00:00Z',
      orgName: 'MIT',
      orgId: 'org-1',
    });
  });

  it('handles RPC errors gracefully', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'RPC failed' },
    });

    const { useMyCredentials } = await import('./useMyCredentials');
    const { result } = renderHook(() => useMyCredentials(), { wrapper: createQueryWrapper() });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('RPC failed');
    expect(result.current.credentials).toEqual([]);
  });

  it('returns empty array when RPC returns null data', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });

    const { useMyCredentials } = await import('./useMyCredentials');
    const { result } = renderHook(() => useMyCredentials(), { wrapper: createQueryWrapper() });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.credentials).toEqual([]);
    expect(result.current.error).toBeNull();
  });
});
