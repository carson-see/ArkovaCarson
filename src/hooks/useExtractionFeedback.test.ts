/**
 * useExtractionFeedback Hook Tests (P8-S6 / AUDIT-12)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useExtractionFeedback } from './useExtractionFeedback';
import type { FeedbackItem } from './useExtractionFeedback';

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

describe('useExtractionFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts with clean state', () => {
    const { result } = renderHook(() => useExtractionFeedback());
    expect(result.current.submitting).toBe(false);
    expect(result.current.accuracyStats).toEqual([]);
    expect(result.current.loadingStats).toBe(false);
  });

  it('submits feedback items', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ stored: 2, errors: 0, total: 2 }),
    });

    const items: FeedbackItem[] = [
      { anchorId: 'a1', fingerprint: 'abc', credentialType: 'DIPLOMA', fieldKey: 'name', action: 'accepted' },
      { anchorId: 'a1', fingerprint: 'abc', credentialType: 'DIPLOMA', fieldKey: 'date', action: 'edited', correctedValue: '2025-06-01' },
    ];

    const { result } = renderHook(() => useExtractionFeedback());

    await act(async () => {
      const res = await result.current.submitFeedback(items);
      expect(res?.stored).toBe(2);
    });
  });

  it('throws on submit failure', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Server error' }),
    });

    const { result } = renderHook(() => useExtractionFeedback());

    await expect(
      act(async () => {
        await result.current.submitFeedback([
          { anchorId: 'a1', fingerprint: 'abc', credentialType: 'DIPLOMA', fieldKey: 'name', action: 'rejected' },
        ]);
      }),
    ).rejects.toThrow('Server error');
  });

  it('fetches accuracy stats', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          stats: [
            {
              credentialType: 'DIPLOMA',
              fieldKey: 'name',
              totalSuggestions: 100,
              acceptedCount: 85,
              rejectedCount: 5,
              editedCount: 10,
              acceptanceRate: 0.85,
              avgConfidence: 0.92,
            },
          ],
        }),
    });

    const { result } = renderHook(() => useExtractionFeedback());

    await act(async () => {
      await result.current.fetchAccuracy('DIPLOMA', 30);
    });

    expect(result.current.accuracyStats).toHaveLength(1);
    expect(result.current.accuracyStats[0].acceptanceRate).toBe(0.85);
  });
});
