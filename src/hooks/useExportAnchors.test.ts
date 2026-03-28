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

  it('should export anchors successfully', async () => {
    mockLimit.mockResolvedValue({ data: mockAnchorData, error: null });

    const { result } = renderHook(() => useExportAnchors());

    let success: boolean;
    await act(async () => {
      success = await result.current.exportAnchors('org-123');
    });

    expect(success!).toBe(true);
    expect(mockDownloadCsv).toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it('should handle fetch error', async () => {
    mockLimit.mockResolvedValue({
      data: null,
      error: { message: 'Database error' },
    });

    const { result } = renderHook(() => useExportAnchors());

    let success: boolean;
    await act(async () => {
      success = await result.current.exportAnchors('org-123');
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
      success = await result.current.exportAnchors('org-123');
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
      await result.current.exportAnchors('org-123');
    });

    expect(result.current.error).not.toBeNull();

    act(() => {
      result.current.clearError();
    });

    expect(result.current.error).toBeNull();
  });
});
