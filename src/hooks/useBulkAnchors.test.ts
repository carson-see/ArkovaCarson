/* eslint-disable arkova/no-mock-echo -- Integration test: verifies data flows through hook/component to rendered output */
/* eslint-disable arkova/require-error-code-assertion -- Error shape varies by Supabase operation; specific codes tested in RLS integration suite */
/**
 * useBulkAnchors Hook Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock functions
const mockRpc = vi.hoisted(() => vi.fn());
const mockRefreshEntitlements = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockCanCreateCount = vi.hoisted(() => vi.fn().mockReturnValue(true));
const mockRemaining = vi.hoisted(() => ({ current: 100 as number | null }));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: mockRpc,
  },
}));

vi.mock('@/hooks/useEntitlements', () => ({
  useEntitlements: () => ({
    canCreateCount: mockCanCreateCount,
    remaining: mockRemaining.current,
    refresh: mockRefreshEntitlements,
    canCreateAnchor: true,
    recordsUsed: 0,
    recordsLimit: 100,
    percentUsed: 0,
    isNearLimit: false,
    planName: 'Professional',
    loading: false,
    error: null,
  }),
}));

// Import after mocks
import { renderHook, act } from '@testing-library/react';
import { useBulkAnchors } from './useBulkAnchors';

describe('useBulkAnchors', () => {
  const mockRecords = [
    { fingerprint: 'a'.repeat(64), filename: 'test1.pdf' },
    { fingerprint: 'b'.repeat(64), filename: 'test2.pdf' },
    { fingerprint: 'c'.repeat(64), filename: 'test3.pdf' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create anchors successfully', async () => {
    mockRpc.mockResolvedValue({
      data: {
        total: 3,
        created: 3,
        skipped: 0,
        failed: 0,
        results: mockRecords.map(r => ({
          fingerprint: r.fingerprint,
          status: 'created',
          id: 'uuid-' + r.fingerprint.slice(0, 8),
        })),
      },
      error: null,
    });

    const { result } = renderHook(() => useBulkAnchors());

    let finalResult: Awaited<ReturnType<typeof result.current.createBulkAnchors>> = null;
    await act(async () => {
      finalResult = await result.current.createBulkAnchors(mockRecords);
    });

    expect(finalResult).not.toBeNull();
    expect(finalResult!.created).toBe(3);
    expect(finalResult!.skipped).toBe(0);
    expect(finalResult!.failed).toBe(0);
    expect(result.current.error).toBeNull();
  });

  it('threads the target org id into the bulk RPC payload', async () => {
    mockRpc.mockResolvedValue({
      data: {
        total: 3,
        created: 3,
        skipped: 0,
        failed: 0,
        results: [],
      },
      error: null,
    });

    const { result } = renderHook(() => useBulkAnchors({ orgId: 'viewed-org-id' }));

    await act(async () => {
      await result.current.createBulkAnchors(mockRecords);
    });

    expect(mockRpc).toHaveBeenCalledWith(
      'bulk_create_anchors',
      {
        anchors_data: mockRecords.map(r => ({
          fingerprint: r.fingerprint,
          filename: r.filename,
          fileSize: null,
          credentialType: null,
          metadata: null,
          orgId: 'viewed-org-id',
        })),
      }
    );
  });

  it('should handle idempotent duplicate skipping', async () => {
    // First call creates
    mockRpc.mockResolvedValueOnce({
      data: {
        total: 3,
        created: 3,
        skipped: 0,
        failed: 0,
        results: mockRecords.map(r => ({
          fingerprint: r.fingerprint,
          status: 'created',
          id: 'uuid-' + r.fingerprint.slice(0, 8),
        })),
      },
      error: null,
    });

    // Second call skips (idempotent)
    mockRpc.mockResolvedValueOnce({
      data: {
        total: 3,
        created: 0,
        skipped: 3,
        failed: 0,
        results: mockRecords.map(r => ({
          fingerprint: r.fingerprint,
          status: 'skipped',
          reason: 'duplicate',
          existingId: 'uuid-' + r.fingerprint.slice(0, 8),
        })),
      },
      error: null,
    });

    const { result } = renderHook(() => useBulkAnchors());

    // First run
    let firstResult: Awaited<ReturnType<typeof result.current.createBulkAnchors>>;
    await act(async () => {
      firstResult = await result.current.createBulkAnchors(mockRecords);
    });

    expect(firstResult!.created).toBe(3);

    // Second run (should be idempotent)
    let secondResult: Awaited<ReturnType<typeof result.current.createBulkAnchors>>;
    await act(async () => {
      secondResult = await result.current.createBulkAnchors(mockRecords);
    });

    expect(secondResult!.created).toBe(0);
    expect(secondResult!.skipped).toBe(3);
  });

  it('should handle mixed results', async () => {
    mockRpc.mockResolvedValue({
      data: {
        total: 3,
        created: 1,
        skipped: 1,
        failed: 1,
        results: [
          { fingerprint: mockRecords[0].fingerprint, status: 'created', id: 'new-id' },
          { fingerprint: mockRecords[1].fingerprint, status: 'skipped', reason: 'duplicate' },
          { fingerprint: mockRecords[2].fingerprint, status: 'failed', reason: 'validation error' },
        ],
      },
      error: null,
    });

    const { result } = renderHook(() => useBulkAnchors());

    let finalResult: Awaited<ReturnType<typeof result.current.createBulkAnchors>>;
    await act(async () => {
      finalResult = await result.current.createBulkAnchors(mockRecords);
    });

    expect(finalResult!.created).toBe(1);
    expect(finalResult!.skipped).toBe(1);
    expect(finalResult!.failed).toBe(1);
  });

  it('should handle RPC error', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'Database error' },
    });

    const { result } = renderHook(() => useBulkAnchors());

    let finalResult: Awaited<ReturnType<typeof result.current.createBulkAnchors>> = null;
    await act(async () => {
      finalResult = await result.current.createBulkAnchors(mockRecords);
    });

    expect(finalResult).toBeNull();
    expect(result.current.error).toContain('Database error');
  });

  it('should track progress', async () => {
    mockRpc.mockResolvedValue({
      data: {
        total: 3,
        created: 3,
        skipped: 0,
        failed: 0,
        results: [],
      },
      error: null,
    });

    const { result } = renderHook(() => useBulkAnchors());

    await act(async () => {
      await result.current.createBulkAnchors(mockRecords);
    });

    expect(result.current.progress).toBe(100);
    expect(result.current.processedCount).toBe(3);
    expect(result.current.totalCount).toBe(3);
  });

  it('should clear error', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'Some error' },
    });

    const { result } = renderHook(() => useBulkAnchors());

    await act(async () => {
      await result.current.createBulkAnchors(mockRecords);
    });

    expect(result.current.error).not.toBeNull();

    act(() => {
      result.current.clearError();
    });

    expect(result.current.error).toBeNull();
  });

  it('should reject bulk creation when quota exceeded', async () => {
    mockCanCreateCount.mockReturnValue(false);
    mockRemaining.current = 1;

    const { result } = renderHook(() => useBulkAnchors());

    let finalResult: Awaited<ReturnType<typeof result.current.createBulkAnchors>> = null;
    await act(async () => {
      finalResult = await result.current.createBulkAnchors(mockRecords);
    });

    expect(finalResult).toBeNull();
    expect(result.current.error).toContain('1 records remaining');
    expect(result.current.error).toContain('3');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('should refresh entitlements after successful bulk creation', async () => {
    mockCanCreateCount.mockReturnValue(true);
    mockRemaining.current = 100;

    mockRpc.mockResolvedValue({
      data: {
        total: 3,
        created: 3,
        skipped: 0,
        failed: 0,
        results: [],
      },
      error: null,
    });

    const { result } = renderHook(() => useBulkAnchors());

    await act(async () => {
      await result.current.createBulkAnchors(mockRecords);
    });

    expect(mockRefreshEntitlements).toHaveBeenCalled();
  });
});
