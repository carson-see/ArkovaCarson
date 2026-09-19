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
const mockToastSuccess = vi.hoisted(() => vi.fn());
const mockToastWarning = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());
const mockWorkerFetch = vi.hoisted(() => vi.fn());

vi.mock('sonner', () => ({
  toast: {
    success: mockToastSuccess,
    warning: mockToastWarning,
    error: mockToastError,
  },
}));

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
vi.mock('@/lib/workerClient', () => ({ workerFetch: mockWorkerFetch }));

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
    mockWorkerFetch.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      const legacy = await mockRpc('bulk_create_anchors', {
        anchors_data: body.rows.map((row: Record<string, unknown>) => ({
          fingerprint: row.fingerprint,
          filename: row.filename,
          fileSize: row.file_size ?? null,
          credentialType: row.credential_type ?? null,
          metadata: row.metadata ?? null,
          fingerprintProvided: row.fingerprint_provided ?? false,
          ...(body.org_id ? { orgId: body.org_id } : {}),
        })),
      });
      return new Response(JSON.stringify(legacy.data ?? {}), { status: legacy.error ? 500 : 200 });
    });
  });

  it('routes an explicit spreadsheet action and shared metadata through the canonical worker boundary', async () => {
    mockWorkerFetch.mockResolvedValue(new Response(JSON.stringify({
      total: 3, created: 3, skipped: 0, failed: 0, results: [],
    }), { status: 200 }));
    const { result } = renderHook(() => useBulkAnchors({ orgId: 'child-org' }));
    await act(async () => {
      await result.current.createBulkAnchors(mockRecords, {
        action: 'instant', description: 'Quarterly import',
        privateTags: { user: ['mine'], organization: ['audit'] },
      });
    });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockWorkerFetch).toHaveBeenCalledWith('/api/v1/anchor-self-service/bulk', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse(mockWorkerFetch.mock.calls[0][1].body);
    expect(body).toMatchObject({
      org_id: 'child-org', action: 'instant', description: 'Quarterly import',
      private_tags: { user: ['mine'], organization: ['audit'] },
    });
    expect(body.rows).toHaveLength(3);
    expect(body.rows[0]).toMatchObject({ fingerprint: 'a'.repeat(64), filename: 'test1.pdf' });
  });

  it('preserves per-row NEEDS_CREDIT outcomes without fabricating failure or success', async () => {
    mockWorkerFetch.mockResolvedValue(new Response(JSON.stringify({
      total: 1, created: 1, skipped: 0, failed: 0,
      results: [{ fingerprint: 'a'.repeat(64), status: 'created', public_id: 'ARK-1', instant_status: 'NEEDS_CREDIT' }],
    }), { status: 200 }));
    const { result } = renderHook(() => useBulkAnchors());
    let outcome: { results: Array<{ status: string; instant_status?: string | null }>; failed: number } | null = null;
    await act(async () => {
      outcome = await result.current.createBulkAnchors([mockRecords[0]], { action: 'instant' });
    });
    expect(outcome).not.toBeNull();
    expect(outcome!.results[0]).toMatchObject({ status: 'created', instant_status: 'NEEDS_CREDIT' });
    expect(outcome!.failed).toBe(0);
  });

  it('does not automatically retry an ambiguous failed chunk', async () => {
    const eleven = Array.from({ length: 11 }, (_, index) => ({
      fingerprint: index.toString(16).padStart(64, '0'), filename: `row-${index}.pdf`,
    }));
    mockWorkerFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ total: 10, created: 10, skipped: 0, failed: 0, results: [] }), { status: 200 }))
      .mockRejectedValueOnce(new Error('connection lost'));
    const { result } = renderHook(() => useBulkAnchors());
    await act(async () => { await result.current.createBulkAnchors(eleven, { action: 'queue' }); });
    expect(mockWorkerFetch).toHaveBeenCalledTimes(2);
    expect(result.current.error).toContain('connection lost');
  });

  it('preserves prior-chunk and structured 503 receipts without replaying either chunk', async () => {
    const eleven = Array.from({ length: 11 }, (_, index) => ({
      fingerprint: index.toString(16).padStart(64, '0'), filename: `row-${index}.pdf`,
    }));
    const firstResults = eleven.slice(0, 10).map((row) => ({ fingerprint: row.fingerprint, status: 'created', public_id: `ARK-${row.filename}` }));
    mockWorkerFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ total: 10, created: 10, skipped: 0, failed: 0, results: firstResults }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        total: 1, created: 1, skipped: 0, failed: 0,
        results: [{ fingerprint: eleven[10].fingerprint, status: 'created', public_id: 'ARK-final', instant_status: 'HELD' }],
      }), { status: 503 }));
    const { result } = renderHook(() => useBulkAnchors({ orgId: 'org-a' }));
    let outcome: Awaited<ReturnType<typeof result.current.createBulkAnchors>> = null;
    await act(async () => { outcome = await result.current.createBulkAnchors(eleven, { action: 'instant' }); });

    expect(mockWorkerFetch).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ total: 11, created: 11, partial: true });
    expect(outcome!.results).toHaveLength(11);
    expect(outcome!.results[10]).toMatchObject({ public_id: 'ARK-final', instant_status: 'HELD' });
    expect(result.current.error).toContain('receipts were preserved');
  });

  it('keeps every chunk in the organization scope captured when submission began', async () => {
    const eleven = Array.from({ length: 11 }, (_, index) => ({
      fingerprint: index.toString(16).padStart(64, '0'), filename: `row-${index}.pdf`,
    }));
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
    mockWorkerFetch
      .mockImplementationOnce(async () => {
        await firstPending;
        return new Response(JSON.stringify({ total: 10, created: 10, skipped: 0, failed: 0, results: [] }), { status: 200 });
      })
      .mockResolvedValueOnce(new Response(JSON.stringify({ total: 1, created: 1, skipped: 0, failed: 0, results: [] }), { status: 200 }));
    const { result, rerender } = renderHook(
      ({ orgId }) => useBulkAnchors({ orgId }),
      { initialProps: { orgId: 'org-a' } },
    );
    let submission!: Promise<unknown>;
    act(() => { submission = result.current.createBulkAnchors(eleven, { action: 'queue' }); });
    await vi.waitFor(() => expect(mockWorkerFetch).toHaveBeenCalledTimes(1));
    rerender({ orgId: 'org-b' });
    releaseFirst();
    await act(async () => { await submission; });

    expect(mockWorkerFetch).toHaveBeenCalledTimes(2);
    expect(mockWorkerFetch.mock.calls.map((call) => JSON.parse(String(call[1].body)).org_id)).toEqual(['org-a', 'org-a']);
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
          // R19: mockRecords don't set fingerprintProvided, so it defaults
          // to false (fail-closed to "unclassified/row-derived" rather than
          // guessing document_bytes).
          fingerprintProvided: false,
          orgId: 'viewed-org-id',
        })),
      }
    );
  });

  // R19 (CTO ruling 2026-07-28): issuer-attestation acknowledgement gate.
  describe('R19 fingerprintProvided / attestation gate', () => {
    it('sends fingerprintProvided=true through to the RPC when a record carries it', async () => {
      mockRpc.mockResolvedValue({
        data: { total: 1, created: 1, skipped: 0, failed: 0, results: [] },
        error: null,
      });

      const { result } = renderHook(() => useBulkAnchors());
      const documentRecord = [{ fingerprint: 'a'.repeat(64), filename: 'doc.pdf', fingerprintProvided: true }];

      await act(async () => {
        await result.current.createBulkAnchors(documentRecord);
      });

      expect(mockRpc).toHaveBeenCalledWith(
        'bulk_create_anchors',
        {
          anchors_data: [
            expect.objectContaining({ fingerprint: 'a'.repeat(64), fingerprintProvided: true }),
          ],
        }
      );
    });

    it('blocks the RPC call and sets an error when a record-derived batch is not attested', async () => {
      const { result } = renderHook(() => useBulkAnchors());
      const recordDerivedRecords = [
        { fingerprint: 'd'.repeat(64), filename: 'row_1.credential', fingerprintProvided: false },
      ];

      let finalResult: Awaited<ReturnType<typeof result.current.createBulkAnchors>> = null;
      await act(async () => {
        finalResult = await result.current.createBulkAnchors(recordDerivedRecords);
      });

      expect(finalResult).toBeNull();
      expect(mockRpc).not.toHaveBeenCalled();
      expect(result.current.error).toBeTruthy();
    });

    it('allows the RPC call when a record-derived batch IS attested', async () => {
      mockRpc.mockResolvedValue({
        data: { total: 1, created: 1, skipped: 0, failed: 0, results: [] },
        error: null,
      });

      const { result } = renderHook(() => useBulkAnchors());
      const recordDerivedRecords = [
        { fingerprint: 'd'.repeat(64), filename: 'row_1.credential', fingerprintProvided: false },
      ];

      let finalResult: Awaited<ReturnType<typeof result.current.createBulkAnchors>> = null;
      await act(async () => {
        finalResult = await result.current.createBulkAnchors(recordDerivedRecords, { attested: true });
      });

      expect(finalResult).not.toBeNull();
      expect(mockRpc).toHaveBeenCalled();
    });

    it('never requires attestation for an all-document-derived batch', async () => {
      mockRpc.mockResolvedValue({
        data: { total: 1, created: 1, skipped: 0, failed: 0, results: [] },
        error: null,
      });

      const { result } = renderHook(() => useBulkAnchors());
      const documentRecords = [
        { fingerprint: 'a'.repeat(64), filename: 'doc.pdf', fingerprintProvided: true },
      ];

      let finalResult: Awaited<ReturnType<typeof result.current.createBulkAnchors>> = null;
      await act(async () => {
        finalResult = await result.current.createBulkAnchors(documentRecords); // no attested flag
      });

      expect(finalResult).not.toBeNull();
      expect(mockRpc).toHaveBeenCalled();
    });
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
    expect(result.current.error).toContain('Failed to process batch');
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

  describe('recipient linking hints', () => {
    const recordsWithEmail = [
      { fingerprint: 'a'.repeat(64), filename: 'test1.pdf', email: 'a@example.com' },
      { fingerprint: 'b'.repeat(64), filename: 'test2.pdf', email: 'b@example.com' },
    ];

    it('sends recipient hints only through the canonical bulk request', async () => {
      const { result } = renderHook(() => useBulkAnchors({ orgId: 'org-1' }));
      await act(async () => {
        await result.current.createBulkAnchors(recordsWithEmail);
      });

      const body = JSON.parse(String(mockWorkerFetch.mock.calls[0][1].body));
      expect(body.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ recipient_email: 'a@example.com' }),
        expect.objectContaining({ recipient_email: 'b@example.com' }),
      ]));
      expect(mockToastSuccess).toHaveBeenCalledTimes(1);
    });
  });
});
