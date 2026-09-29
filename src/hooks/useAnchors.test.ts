/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping */
/**
 * useAnchors Hook Tests
 *
 * Tests anchor fetching, mapping, error handling, and refresh.
 *
 * @see P3-TS-01
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockFrom = vi.hoisted(() => vi.fn());
const mockGetSession = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: mockFrom,
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
    })),
    removeChannel: vi.fn(),
    auth: {
      getSession: mockGetSession,
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
    },
  },
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('./useProfile', () => ({
  useProfile: () => ({
    profile: { role: 'INDIVIDUAL', org_id: null },
    loading: false,
    updateProfile: vi.fn(),
  }),
}));

describe('useAnchors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetSession.mockResolvedValue({
      data: { session: { user: { id: 'user-1', email: 'test@test.com' } } },
      error: null,
    });
  });

  function createWrapper() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    return ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children);
  }

  it('returns empty records when user is not authenticated', async () => {
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });

    const { useAnchors } = await import('./useAnchors');
    const { result } = renderHook(() => useAnchors(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.records).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('fetches and maps anchors from Supabase', async () => {
    const mockAnchors = [
      {
        id: 'anchor-1',
        filename: 'test.pdf',
        fingerprint: 'abc123',
        status: 'SECURED',
        created_at: '2026-03-01T00:00:00Z',
        chain_timestamp: '2026-03-01T01:00:00Z',
        file_size: 1024,
        credential_type: 'DIPLOMA',
        folder_id: 'folder-9',
      },
    ];

    const mockIs = vi.fn();
    mockIs.mockReturnValue({
      is: mockIs,
      order: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue({ data: mockAnchors, error: null }),
      }),
    });
    const mockSelect = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        is: mockIs,
      }),
    });
    mockFrom.mockReturnValue({
      select: mockSelect,
    });

    const { useAnchors } = await import('./useAnchors');
    const { result } = renderHook(() => useAnchors(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.records).toHaveLength(1);
    expect(result.current.records[0]).toMatchObject({
      id: 'anchor-1',
      filename: 'test.pdf',
      fingerprint: 'abc123',
      status: 'SECURED',
      createdAt: '2026-03-01T00:00:00Z',
      securedAt: '2026-03-01T01:00:00Z',
      fileSize: 1024,
      credentialType: 'DIPLOMA',
      folderId: 'folder-9',
    });
    // SCRUM-2940: the folders UI filters by folder_id, so the anchors select
    // must include it (do not restructure the hook, just extend the select).
    expect(mockSelect).toHaveBeenCalledWith(expect.stringContaining('folder_id'));
  });

  it('sets error when fetch fails', async () => {
    const mockIs = vi.fn();
    mockIs.mockReturnValue({
      is: mockIs,
      order: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue({
          data: null,
          error: { message: 'RLS policy violation' },
        }),
      }),
    });
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          is: mockIs,
        }),
      }),
    });

    const { useAnchors } = await import('./useAnchors');
    const { result } = renderHook(() => useAnchors(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('RLS policy violation');
    expect(result.current.records).toEqual([]);
  });

  it('maps null chain_timestamp to undefined securedAt', async () => {
    const mockAnchors = [
      {
        id: 'anchor-2',
        filename: 'pending.pdf',
        fingerprint: 'def456',
        status: 'PENDING',
        created_at: '2026-03-01T00:00:00Z',
        chain_timestamp: null,
        file_size: null,
        credential_type: null,
        folder_id: null,
      },
    ];

    const mockIs = vi.fn();
    mockIs.mockReturnValue({
      is: mockIs,
      order: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue({ data: mockAnchors, error: null }),
      }),
    });
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          is: mockIs,
        }),
      }),
    });

    const { useAnchors } = await import('./useAnchors');
    const { result } = renderHook(() => useAnchors(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.records[0].securedAt).toBeUndefined();
    expect(result.current.records[0].fileSize).toBe(0);
    expect(result.current.records[0].credentialType).toBeUndefined();
    expect(result.current.records[0].folderId).toBeNull();
  });
});

describe('useAnchors selected-scope realtime guards', () => {
  it('never admits another org and limits ordinary members to their own rows', async () => {
    const { anchorBelongsToScope } = await import('./useAnchors');
    expect(anchorBelongsToScope({ org_id: 'org-2', user_id: 'other' } as never, 'user-1', 'org-1', 'ORG_ADMIN')).toBe(false);
    expect(anchorBelongsToScope({ org_id: 'org-1', user_id: 'other' } as never, 'user-1', 'org-1', 'INDIVIDUAL')).toBe(false);
    expect(anchorBelongsToScope({ org_id: 'org-1', user_id: 'user-1' } as never, 'user-1', 'org-1', 'INDIVIDUAL')).toBe(true);
  });

  it('removes soft-deleted and connector-pipeline rows from realtime views', async () => {
    const { anchorIsVisibleRealtime } = await import('./useAnchors');
    expect(anchorIsVisibleRealtime({ deleted_at: '2026-01-01', metadata: null } as never)).toBe(false);
    expect(anchorIsVisibleRealtime({ deleted_at: null, metadata: { pipeline_source: 'connector' } } as never)).toBe(false);
    expect(anchorIsVisibleRealtime({ deleted_at: null, metadata: {} } as never)).toBe(true);
  });
});

// 2026-09-29 dashboard follow-up: the record card's version chip needs
// version_number/parent_anchor_id, which mapAnchorToRecord now carries
// through (RLS-scoped select, added alongside the other card fields).
describe('mapAnchorToRecord — version lineage fields', () => {
  it('maps version_number and parent_anchor_id onto the Record', async () => {
    const { mapAnchorToRecord } = await import('./useAnchors');
    const record = mapAnchorToRecord({
      id: 'anchor-1',
      filename: 'v2.pdf',
      fingerprint: 'a'.repeat(64),
      status: 'SECURED',
      created_at: '2026-09-01T00:00:00Z',
      chain_timestamp: null,
      file_size: 100,
      credential_type: null,
      chain_tx_id: null,
      chain_block_height: null,
      public_id: 'ARK-DOC-1',
      metadata: null,
      folder_id: null,
      version_number: 2,
      parent_anchor_id: 'anchor-0',
    } as never);

    expect(record.versionNumber).toBe(2);
    expect(record.parentAnchorId).toBe('anchor-0');
  });

  it('defaults parentAnchorId to null and versionNumber to undefined when absent', async () => {
    const { mapAnchorToRecord } = await import('./useAnchors');
    const record = mapAnchorToRecord({
      id: 'anchor-1',
      filename: 'v1.pdf',
      fingerprint: 'a'.repeat(64),
      status: 'SECURED',
      created_at: '2026-09-01T00:00:00Z',
      chain_timestamp: null,
      file_size: 100,
      credential_type: null,
      chain_tx_id: null,
      chain_block_height: null,
      public_id: 'ARK-DOC-1',
      metadata: null,
      folder_id: null,
      version_number: null,
      parent_anchor_id: null,
    } as never);

    expect(record.versionNumber).toBeUndefined();
    expect(record.parentAnchorId).toBeNull();
  });
});
