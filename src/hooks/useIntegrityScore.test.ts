/**
 * useIntegrityScore Hook Tests (P8-S8 / AUDIT-12)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIntegrityScore } from './useIntegrityScore';

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

const mockScoreData = {
  id: 'is1',
  anchorId: 'a1',
  orgId: 'org1',
  overallScore: 87,
  level: 'HIGH' as const,
  metadataCompleteness: 90,
  extractionConfidence: 85,
  issuerVerification: 92,
  duplicateCheck: 80,
  temporalConsistency: 88,
  flags: [],
  details: {},
  computedAt: '2026-03-17T00:00:00Z',
};

describe('useIntegrityScore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts with null score', () => {
    const { result } = renderHook(() => useIntegrityScore());
    expect(result.current.score).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.computing).toBe(false);
  });

  it('fetches score for an anchor', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockScoreData),
    });

    const { result } = renderHook(() => useIntegrityScore());

    await act(async () => {
      const data = await result.current.fetchScore('a1');
      expect(data?.overallScore).toBe(87);
    });

    expect(result.current.score?.level).toBe('HIGH');
  });

  it('handles 404 (no score yet)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });

    const { result } = renderHook(() => useIntegrityScore());

    await act(async () => {
      const data = await result.current.fetchScore('nonexistent');
      expect(data).toBeNull();
    });

    expect(result.current.score).toBeNull();
  });

  it('computes score and then refetches', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            anchorId: 'a1',
            score: 87,
            level: 'HIGH',
            breakdown: { metadataCompleteness: 90, extractionConfidence: 85, issuerVerification: 92, duplicateCheck: 80, temporalConsistency: 88 },
            flags: [],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockScoreData),
      });

    const { result } = renderHook(() => useIntegrityScore());

    await act(async () => {
      const data = await result.current.computeScore('a1');
      expect(data?.score).toBe(87);
    });
  });
});
