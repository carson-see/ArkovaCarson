/* eslint-disable arkova/no-unscoped-service-test -- Frontend: RLS enforced server-side by Supabase JWT, not manual query scoping */
/**
 * useAnchorVersions Hook Tests
 *
 * TDD red-first for the record-detail readability pass (founder-reported,
 * 2026-09-29): the version chain used to be fetched ad hoc inside
 * RecordDetailPage.tsx, gated on `version_number > 1 || parent_anchor_id`.
 * That gate MISSED the root/oldest version of a chain — a record with
 * version_number === 1 and no parent that had ALREADY been superseded by a
 * newer child never fetched its lineage, so it showed no version banner and
 * no "a newer version exists" link at all. This hook always attempts to walk
 * both directions and lets an empty chain (length <= 1) speak for itself.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const mockFrom = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: { from: mockFrom },
}));

/**
 * Builds a `.from().select().eq().is()` chain whose `.single()` resolves to
 * `singleRow` (the anchor's own row-by-id fetch) and whose `.order().limit()`
 * resolves to `rows` (the children-by-parent fetch) — both branches the hook
 * exercises even when there is no lineage to find.
 */
function listChain(rows: unknown[], singleRow: unknown = null) {
  return {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        is: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: singleRow,
            error: singleRow ? null : { code: 'PGRST116' },
          }),
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: rows, error: null }),
          }),
        }),
      }),
    }),
  };
}

describe('useAnchorVersions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a single-entry-or-empty result for a record with no parent and no children', async () => {
    const row = {
      id: 'anchor-1',
      public_id: 'ARK-DOC-1',
      version_number: 1,
      status: 'SECURED',
      created_at: '2026-09-01T00:00:00Z',
      filename: 'plain.pdf',
      fingerprint: 'a'.repeat(64),
    };
    mockFrom.mockImplementation((table: string) => {
      if (table !== 'anchors') throw new Error(`unexpected table ${table}`);
      return listChain([], row);
    });

    const { useAnchorVersions } = await import('./useAnchorVersions');
    const { result } = renderHook(() =>
      useAnchorVersions({ id: 'anchor-1', versionNumber: 1, parentAnchorId: null, status: 'SECURED' }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    // The chain is just the record itself — callers gate a visible version
    // banner/list on `versions.length > 1`, not on this hook returning [].
    expect(result.current.versions.map((v) => v.id)).toEqual(['anchor-1']);
  });

  it('finds a newer child even when the current record is version 1 with no parent (the reported gap)', async () => {
    const rootRow = {
      id: 'anchor-1',
      public_id: 'ARK-DOC-1',
      version_number: 1,
      status: 'SUPERSEDED',
      created_at: '2026-09-01T00:00:00Z',
      filename: 'google_drive:internal-id',
      fingerprint: 'e'.repeat(64),
    };
    const child = {
      id: 'anchor-2',
      public_id: 'ARK-DOC-2',
      version_number: 2,
      status: 'SECURED',
      created_at: '2026-09-29T00:00:00Z',
      filename: 'Q3 Vendor Agreement.gsheet',
      fingerprint: 'f'.repeat(64),
    };

    let childServed = false;
    mockFrom.mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          is: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: rootRow, error: null }),
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockImplementation(() => {
                if (childServed) return Promise.resolve({ data: [], error: null });
                childServed = true;
                return Promise.resolve({ data: [child], error: null });
              }),
            }),
          }),
        }),
      }),
    }));

    const { useAnchorVersions } = await import('./useAnchorVersions');
    // The root itself: version_number 1, parent_anchor_id null, status
    // SUPERSEDED — exactly the founder-reported record.
    const { result } = renderHook(() =>
      useAnchorVersions({ id: 'anchor-1', versionNumber: 1, parentAnchorId: null, status: 'SUPERSEDED' }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.versions.map((v) => v.id)).toContain('anchor-2');
  });

  it('walks up to the root through parent_anchor_id, then collects every descendant, newest first', async () => {
    const root = {
      id: 'root',
      public_id: 'ARK-DOC-ROOT',
      version_number: 1,
      status: 'SUPERSEDED',
      created_at: '2026-01-01T00:00:00Z',
      filename: 'root.pdf',
      fingerprint: 'a'.repeat(64),
    };
    const v2 = {
      id: 'v2',
      public_id: 'ARK-DOC-V2',
      version_number: 2,
      status: 'SUPERSEDED',
      created_at: '2026-02-01T00:00:00Z',
      filename: 'v2.pdf',
      fingerprint: 'b'.repeat(64),
    };
    const v3 = {
      id: 'v3',
      public_id: 'ARK-DOC-V3',
      version_number: 3,
      status: 'SECURED',
      created_at: '2026-03-01T00:00:00Z',
      filename: 'v3.pdf',
      fingerprint: 'c'.repeat(64),
    };

    mockFrom.mockImplementation(() => ({
      select: vi.fn((cols: string) => {
        // Distinguish the parent-walk query (id, parent_anchor_id) from the
        // full-row queries by the requested column list.
        if (cols.includes('parent_anchor_id') && !cols.includes('version_number')) {
          return {
            eq: vi.fn((_col: string, val: string) => ({
              is: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: val === 'root' ? { id: 'root', parent_anchor_id: null } : null,
                  error: null,
                }),
              }),
            })),
          };
        }
        return {
          eq: vi.fn((col: string, val: string) => ({
            is: vi.fn().mockReturnValue({
              single: vi.fn().mockImplementation(() => {
                if (col === 'id' && val === 'root') return Promise.resolve({ data: root, error: null });
                return Promise.resolve({ data: null, error: { code: 'PGRST116' } });
              }),
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockImplementation(() => {
                  if (col === 'parent_anchor_id' && val === 'root') {
                    return Promise.resolve({ data: [v2], error: null });
                  }
                  if (col === 'parent_anchor_id' && val === 'v2') {
                    return Promise.resolve({ data: [v3], error: null });
                  }
                  return Promise.resolve({ data: [], error: null });
                }),
              }),
            }),
          })),
        };
      }),
    }));

    const { useAnchorVersions } = await import('./useAnchorVersions');
    // Current anchor is v2 (mid-chain): parentAnchorId points at root.
    const { result } = renderHook(() =>
      useAnchorVersions({ id: 'v2', versionNumber: 2, parentAnchorId: 'root', status: 'SUPERSEDED' }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.versions.map((v) => v.versionNumber)).toEqual([3, 2, 1]);
    expect(result.current.versions.map((v) => v.id)).toEqual(['v3', 'v2', 'root']);
    // Public-safe field is present for callers that want to link via public_id.
    expect(result.current.versions[0].publicId).toBe('ARK-DOC-V3');
  });

  it('returns an empty list and stops loading when given no anchor', async () => {
    const { useAnchorVersions } = await import('./useAnchorVersions');
    const { result } = renderHook(() => useAnchorVersions(null));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.versions).toEqual([]);
  });
});
