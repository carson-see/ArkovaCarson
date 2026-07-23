/* eslint-disable arkova/require-error-code-assertion -- Error shape varies by Supabase operation; specific codes tested in RLS integration suite */
/**
 * useExportAnchors Hook Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock functions
const mockSelect = vi.hoisted(() => vi.fn());
const mockEq = vi.hoisted(() => vi.fn());
const mockIs = vi.hoisted(() => vi.fn());
const mockOrder = vi.hoisted(() => vi.fn());
const mockLimit = vi.hoisted(() => vi.fn());
const mockDownloadCsv = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: mockSelect,
    }),
  },
}));

vi.mock('@/lib/csvExport', () => ({
  generateCsv: vi.fn().mockReturnValue('header\nrow1\nrow2'),
  downloadCsv: mockDownloadCsv,
  formatDateForCsv: vi.fn((d) => d || ''),
  generateExportFilename: vi.fn().mockReturnValue('org-records-2024-01-15.csv'),
}));

// Import after mocks
import { renderHook, act } from '@testing-library/react';
import { useExportAnchors } from './useExportAnchors';

describe('useExportAnchors', () => {
  const mockAnchorData = [
    {
      id: '1',
      filename: 'test.pdf',
      fingerprint: 'abc123',
      status: 'SECURED',
      file_size: 1024,
      mime_type: 'application/pdf',
      created_at: '2024-01-15T00:00:00Z',
      updated_at: '2024-01-15T00:00:00Z',
      secured_at: '2024-01-15T01:00:00Z',
      legal_hold: false,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();

    // Set up the chain of mock methods
    mockSelect.mockReturnValue({
      eq: mockEq,
    });
    mockEq.mockReturnValue({
      is: mockIs,
    });
    mockIs.mockReturnValue({
      order: mockOrder,
    });
    mockOrder.mockReturnValue({
      limit: mockLimit,
    });
  });

  it('should export anchors successfully (admin — org-wide)', async () => {
    mockLimit.mockResolvedValue({ data: mockAnchorData, error: null });

    const { result } = renderHook(() => useExportAnchors());

    let success: boolean;
    await act(async () => {
      success = await result.current.exportAnchors('org-123', { isAdmin: true });
    });

    expect(success!).toBe(true);
    expect(mockDownloadCsv).toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    // Admin export is scoped to the whole org.
    expect(mockEq).toHaveBeenCalledWith('org_id', 'org-123');
  });

  it('should handle fetch error', async () => {
    mockLimit.mockResolvedValue({
      data: null,
      error: { message: 'Database error' },
    });

    const { result } = renderHook(() => useExportAnchors());

    let success: boolean;
    await act(async () => {
      success = await result.current.exportAnchors('org-123', { isAdmin: true });
    });

    expect(success!).toBe(false);
    expect(result.current.error).toContain('Database error');
    expect(mockDownloadCsv).not.toHaveBeenCalled();
  });

  it('should handle empty data', async () => {
    mockLimit.mockResolvedValue({ data: [], error: null });

    const { result } = renderHook(() => useExportAnchors());

    let success: boolean;
    await act(async () => {
      success = await result.current.exportAnchors('org-123', { isAdmin: true });
    });

    expect(success!).toBe(false);
    expect(result.current.error).toContain('No records');
    expect(mockDownloadCsv).not.toHaveBeenCalled();
  });

  it('should clear error', async () => {
    mockLimit.mockResolvedValue({
      data: null,
      error: { message: 'Some error' },
    });

    const { result } = renderHook(() => useExportAnchors());

    await act(async () => {
      await result.current.exportAnchors('org-123', { isAdmin: true });
    });

    expect(result.current.error).not.toBeNull();

    act(() => {
      result.current.clearError();
    });

    expect(result.current.error).toBeNull();
  });

  // SCRUM-3010 STEP 1 (frontend gate): a non-admin org member must only ever
  // export their OWN records, never the whole organization's. The export query
  // must be scoped by user_id (mirrors the useAnchors INDIVIDUAL path), NOT by
  // org_id, so a coworker's filenames/fingerprints/metadata can never be pulled.
  it('scopes a non-admin export to user_id, never org-wide', async () => {
    mockLimit.mockResolvedValue({ data: mockAnchorData, error: null });

    const { result } = renderHook(() => useExportAnchors());

    let success: boolean;
    await act(async () => {
      success = await result.current.exportAnchors('org-123', {
        isAdmin: false,
        userId: 'user-abc',
      });
    });

    expect(success!).toBe(true);
    // Scoped to the caller's own rows...
    expect(mockEq).toHaveBeenCalledWith('user_id', 'user-abc');
    // ...and NEVER to the whole org.
    expect(mockEq).not.toHaveBeenCalledWith('org_id', 'org-123');
  });

  // SCRUM-3010 STEP 1: fail closed. A non-admin with no resolved user id must
  // NOT fall through to an org-wide fetch — it must refuse to export.
  it('refuses a non-admin export when the user id is missing (fail closed)', async () => {
    mockLimit.mockResolvedValue({ data: mockAnchorData, error: null });

    const { result } = renderHook(() => useExportAnchors());

    let success: boolean;
    await act(async () => {
      success = await result.current.exportAnchors('org-123', { isAdmin: false });
    });

    expect(success!).toBe(false);
    expect(mockDownloadCsv).not.toHaveBeenCalled();
    // Must never issue an org-wide query for a non-admin.
    expect(mockEq).not.toHaveBeenCalledWith('org_id', 'org-123');
  });
});
