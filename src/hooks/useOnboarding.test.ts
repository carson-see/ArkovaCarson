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
