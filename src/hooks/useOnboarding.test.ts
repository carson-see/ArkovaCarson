/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping */
/* eslint-disable arkova/no-mock-echo -- Integration test: verifies data flows through hook/component to rendered output */
/* eslint-disable arkova/require-error-code-assertion -- Error shape varies by Supabase operation; specific codes tested in RLS integration suite */
/**
 * useOnboarding Hook Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock functions
const { mockRpc, mockFrom } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockFrom: vi.fn(() => ({
    insert: vi.fn(() => ({
      select: vi.fn(() => ({
        single: vi.fn().mockResolvedValue({ data: { id: 'new-org-direct' }, error: null }),
      })),
    })),
    update: vi.fn(() => ({
      eq: vi.fn().mockResolvedValue({ error: null }),
    })),
  })),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: mockRpc,
    from: mockFrom,
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-123' } } }) },
  },
}));

// Import after mocks
import { renderHook, act } from '@testing-library/react';
import { useOnboarding } from './useOnboarding';

// mockFrom's inferred return type requires both `insert` and `update` (from
// the default factory above), so a per-call override needs both present too.
// This queues one `.from(...)` call with sensible no-op defaults, letting
// each test override only the branch(es) it cares about.
type FromChain = ReturnType<typeof mockFrom>;

function queueFrom(overrides: Partial<FromChain>) {
  mockFrom.mockReturnValueOnce({
    insert: vi.fn(() => ({
      select: vi.fn(() => ({
        single: vi.fn().mockResolvedValue({ data: null, error: null }),
      })),
    })),
    update: vi.fn(() => ({
      eq: vi.fn().mockResolvedValue({ error: null }),
    })),
    ...overrides,
  });
}

describe('useOnboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('setRole', () => {
    it('should set INDIVIDUAL role successfully', async () => {
      mockRpc.mockResolvedValue({
        data: {
          success: true,
          role: 'INDIVIDUAL',
          already_set: false,
          user_id: 'test-user-id',
        },
        error: null,
      });

      const { result } = renderHook(() => useOnboarding());

      let finalResult: Awaited<ReturnType<typeof result.current.setRole>> = null;
      await act(async () => {
        finalResult = await result.current.setRole('INDIVIDUAL');
      });

      expect(finalResult).not.toBeNull();
      expect(finalResult!.success).toBe(true);
      expect(finalResult!.role).toBe('INDIVIDUAL');
      expect(result.current.error).toBeNull();
    });

    it('should handle idempotent role setting', async () => {
      mockRpc.mockResolvedValue({
        data: {
          success: true,
          role: 'INDIVIDUAL',
          already_set: true,
          user_id: 'test-user-id',
        },
        error: null,
      });

      const { result } = renderHook(() => useOnboarding());

      let finalResult: Awaited<ReturnType<typeof result.current.setRole>> = null;
      await act(async () => {
        finalResult = await result.current.setRole('INDIVIDUAL');
      });

      expect(finalResult!.already_set).toBe(true);
      expect(result.current.error).toBeNull();
    });

    it('should handle RPC error', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'Not authenticated' },
      });

      const { result } = renderHook(() => useOnboarding());

      let finalResult: Awaited<ReturnType<typeof result.current.setRole>> = null;
      await act(async () => {
        finalResult = await result.current.setRole('INDIVIDUAL');
      });

      expect(finalResult).toBeNull();
      expect(result.current.error).toBe('Not authenticated');
    });
  });

  describe('createOrg', () => {
    it('should create org successfully', async () => {
      mockRpc.mockResolvedValue({
        data: {
          success: true,
          role: 'ORG_ADMIN',
          already_set: false,
          user_id: 'test-user-id',
          org_id: 'new-org-id',
        },
        error: null,
      });

      const { result } = renderHook(() => useOnboarding());

      let finalResult: Awaited<ReturnType<typeof result.current.createOrg>> = null;
      await act(async () => {
        finalResult = await result.current.createOrg({
          legalName: 'Test Corp Inc.',
          displayName: 'Test Corp',
          domain: 'testcorp.com',
        });
      });

      expect(finalResult).not.toBeNull();
      expect(finalResult!.success).toBe(true);
      expect(finalResult!.role).toBe('ORG_ADMIN');
      expect(finalResult!.org_id).toBe('new-org-id');
      expect(result.current.error).toBeNull();
    });

    it('should handle missing legal name error', async () => {
      // RPC fails AND direct insert fails (both return errors)
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'Organization legal name is required for ORG_ADMIN' },
      });
      mockFrom.mockReturnValueOnce({
        insert: vi.fn(() => ({
          select: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({ data: null, error: { message: 'Organization legal name is required' } }),
          })),
        })),
        update: vi.fn(() => ({
          eq: vi.fn().mockResolvedValue({ error: null }),
        })),
      });

      const { result } = renderHook(() => useOnboarding());

      let finalResult: Awaited<ReturnType<typeof result.current.createOrg>> = null;
      await act(async () => {
        finalResult = await result.current.createOrg({
          legalName: '',
          displayName: '',
          domain: null,
        });
      });

      expect(finalResult).toBeNull();
      expect(result.current.error).toContain('legal name is required');
    });

    // BUG (2026-08-03 bug sprint): the direct-insert fallback (RPC errored,
    // "user already onboarded") previously discarded the org_members insert
    // and profiles update results entirely — not even `{ error }` was
    // captured. A failure there still returned `success: true` with an
    // `org_id`, so OnboardingOrgPage's refreshProfile() would refetch a
    // profile whose org_id never actually got set, and RouteGuard would
    // silently bounce the user back into the same onboarding form — with a
    // real, orphaned `organizations` row already sitting in the DB, and a
    // second one created on retry.
    it('returns null and sets error when org_members insert fails after direct org fallback', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'Not authenticated' },
      });
      queueFrom({
        insert: vi.fn(() => ({
          select: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({ data: { id: 'new-org-id' }, error: null }),
          })),
        })),
      });
      queueFrom({
        insert: vi.fn().mockResolvedValue({ error: { message: 'duplicate membership' } }),
      });

      const { result } = renderHook(() => useOnboarding());

      let finalResult: Awaited<ReturnType<typeof result.current.createOrg>> = null;
      await act(async () => {
        finalResult = await result.current.createOrg({
          legalName: 'Test Corp Inc.',
          displayName: 'Test Corp',
          domain: 'testcorp.com',
        });
      });

      expect(finalResult).toBeNull();
      expect(result.current.error).toBe('duplicate membership');
    });

    it('returns null and sets error when the profile update fails after direct org fallback', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'Not authenticated' },
      });
      queueFrom({
        insert: vi.fn(() => ({
          select: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({ data: { id: 'new-org-id' }, error: null }),
          })),
        })),
      });
      queueFrom({ insert: vi.fn().mockResolvedValue({ error: null }) });
      queueFrom({
        update: vi.fn(() => ({
          eq: vi.fn().mockResolvedValue({ error: { message: 'permission denied for table profiles' } }),
        })),
      });

      const { result } = renderHook(() => useOnboarding());

      let finalResult: Awaited<ReturnType<typeof result.current.createOrg>> = null;
      await act(async () => {
        finalResult = await result.current.createOrg({
          legalName: 'Test Corp Inc.',
          displayName: 'Test Corp',
          domain: 'testcorp.com',
        });
      });

      expect(finalResult).toBeNull();
      expect(result.current.error).toBe('permission denied for table profiles');
    });

    it('returns success when org_members insert and profile update both succeed (direct fallback)', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'Not authenticated' },
      });
      queueFrom({
        insert: vi.fn(() => ({
          select: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({ data: { id: 'new-org-id' }, error: null }),
          })),
        })),
      });
      queueFrom({ insert: vi.fn().mockResolvedValue({ error: null }) });
      queueFrom({ update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })) });

      const { result } = renderHook(() => useOnboarding());

      let finalResult: Awaited<ReturnType<typeof result.current.createOrg>> = null;
      await act(async () => {
        finalResult = await result.current.createOrg({
          legalName: 'Test Corp Inc.',
          displayName: 'Test Corp',
          domain: 'testcorp.com',
        });
      });

      expect(finalResult).not.toBeNull();
      expect(finalResult!.success).toBe(true);
      expect(finalResult!.org_id).toBe('new-org-id');
      expect(result.current.error).toBeNull();
    });

    // Same bug, second call site: the RPC-succeeds-but-already_set-with-no-org
    // branch had an identical unchecked org_members insert + profiles update.
    it('returns null and sets error when the profile update fails in the already_set fallback branch', async () => {
      mockRpc.mockResolvedValue({
        data: {
          success: true,
          role: 'ORG_ADMIN',
          already_set: true,
          user_id: 'test-user-id',
        },
        error: null,
      });
      queueFrom({
        insert: vi.fn(() => ({
          select: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({ data: { id: 'new-org-id-2' }, error: null }),
          })),
        })),
      });
      queueFrom({ insert: vi.fn().mockResolvedValue({ error: null }) });
      queueFrom({
        update: vi.fn(() => ({
          eq: vi.fn().mockResolvedValue({ error: { message: 'RLS blocked profile update' } }),
        })),
      });

      const { result } = renderHook(() => useOnboarding());

      let finalResult: Awaited<ReturnType<typeof result.current.createOrg>> = null;
      await act(async () => {
        finalResult = await result.current.createOrg({
          legalName: 'Test Corp Inc.',
          displayName: 'Test Corp',
          domain: 'testcorp.com',
        });
      });

      expect(finalResult).toBeNull();
      expect(result.current.error).toBe('RLS blocked profile update');
    });

    it('returns success and sets org_id when already_set fallback fully succeeds', async () => {
      mockRpc.mockResolvedValue({
        data: {
          success: true,
          role: 'ORG_ADMIN',
          already_set: true,
          user_id: 'test-user-id',
        },
        error: null,
      });
      queueFrom({
        insert: vi.fn(() => ({
          select: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({ data: { id: 'new-org-id-3' }, error: null }),
          })),
        })),
      });
      queueFrom({ insert: vi.fn().mockResolvedValue({ error: null }) });
      queueFrom({ update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })) });

      const { result } = renderHook(() => useOnboarding());

      let finalResult: Awaited<ReturnType<typeof result.current.createOrg>> = null;
      await act(async () => {
        finalResult = await result.current.createOrg({
          legalName: 'Test Corp Inc.',
          displayName: 'Test Corp',
          domain: 'testcorp.com',
        });
      });

      expect(finalResult).not.toBeNull();
      expect(finalResult!.success).toBe(true);
      expect(finalResult!.org_id).toBe('new-org-id-3');
      expect(result.current.error).toBeNull();
    });
  });

  describe('clearError', () => {
    it('should clear error state', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'Some error' },
      });

      const { result } = renderHook(() => useOnboarding());

      await act(async () => {
        await result.current.setRole('INDIVIDUAL');
      });

      expect(result.current.error).not.toBeNull();

      act(() => {
        result.current.clearError();
      });

      expect(result.current.error).toBeNull();
    });
  });
});
