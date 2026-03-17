/**
 * useAIReports Hook Tests (P8-S16 / AUDIT-12)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAIReports } from './useAIReports';

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: 'test-token' } },
      }),
    },
  },
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

const mockReport = {
  id: 'r1',
  orgId: 'org1',
  requestedBy: 'user1',
  reportType: 'integrity_summary',
  status: 'COMPLETE',
  title: 'Test Report',
  parameters: {},
  result: { summary: 'All good' },
  errorMessage: null,
  startedAt: '2026-03-17T00:00:00Z',
  completedAt: '2026-03-17T00:01:00Z',
  createdAt: '2026-03-17T00:00:00Z',
};

describe('useAIReports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts with empty reports', () => {
    const { result } = renderHook(() => useAIReports());
    expect(result.current.reports).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.creating).toBe(false);
  });

  it('fetches reports list', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ reports: [mockReport] }),
    });

    const { result } = renderHook(() => useAIReports());

    await act(async () => {
      await result.current.fetchReports();
    });

    expect(result.current.reports).toHaveLength(1);
    expect(result.current.reports[0].id).toBe('r1');
  });

  it('creates a report and refreshes list', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ reportId: 'r2', status: 'QUEUED' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ reports: [mockReport] }),
      });

    const { result } = renderHook(() => useAIReports());

    await act(async () => {
      const id = await result.current.createReport('integrity_summary', 'New Report');
      expect(id).toBe('r2');
    });
  });

  it('fetches a single report by ID', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockReport),
    });

    const { result } = renderHook(() => useAIReports());

    await act(async () => {
      const report = await result.current.fetchReport('r1');
      expect(report?.id).toBe('r1');
    });
  });

  it('returns null for non-existent report', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });

    const { result } = renderHook(() => useAIReports());

    await act(async () => {
      const report = await result.current.fetchReport('nonexistent');
      expect(report).toBeNull();
    });
  });
});
