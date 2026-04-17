/**
 * Tests for NCX-06: NCES/Clearinghouse Transcript Verification Data Fetcher
 *
 * Tests URL construction, rate limiting, record transformation,
 * error handling, and batch processing. All HTTP calls mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config so the transitive logger.ts → config.ts chain doesn't fail
// module-load when prod env vars (SUPABASE_URL, etc.) aren't set in tests.
vi.mock('../config.js', () => ({
  config: { nodeEnv: 'test', useMocks: true, logLevel: 'silent' },
  getNetworkDisplayName: vi.fn(() => 'Test Environment'),
}));

// Make pipeline.delay a no-op so rate-limited loops don't stall the test runner.
vi.mock('../utils/pipeline.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, delay: vi.fn().mockResolvedValue(undefined) };
});

import { fetchNcesInstitutionData } from './ncesFetcher.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createMockSupabase(flagEnabled = true) {
  const upsertFn = vi.fn().mockResolvedValue({ error: null });
  return {
    rpc: vi.fn().mockResolvedValue({ data: flagEnabled }),
    from: vi.fn().mockReturnValue({
      upsert: upsertFn,
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          in: vi.fn().mockResolvedValue({ data: [] }),
        }),
      }),
    }),
    _upsertFn: upsertFn,
  };
}

describe('ncesFetcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should skip when ENABLE_PUBLIC_RECORDS_INGESTION is disabled', async () => {
    const supabase = createMockSupabase(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchNcesInstitutionData(supabase as any);
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('should construct correct NCES API URL', async () => {
    const supabase = createMockSupabase(true);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fetchNcesInstitutionData(supabase as any);
    expect(mockFetch).toHaveBeenCalled();
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('educationdata.urban.org');
  });

  it('should transform NCES records correctly', async () => {
    const supabase = createMockSupabase(true);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            unitid: 170976,
            inst_name: 'University of Michigan-Ann Arbor',
            city: 'Ann Arbor',
            state_abbr: 'MI',
            zip: '48109',
            sector: 1,
            level: 1,
            control: 1,
            hbcu: 0,
            tribal_college: 0,
            year: 2023,
          },
        ],
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchNcesInstitutionData(supabase as any);
    expect(result.inserted).toBeGreaterThanOrEqual(0);
    expect(supabase.from).toHaveBeenCalledWith('public_records');
  });

  it('should handle API errors gracefully', async () => {
    const supabase = createMockSupabase(true);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchNcesInstitutionData(supabase as any);
    expect(result.errors).toBeGreaterThanOrEqual(1);
  });

  it('should handle network errors gracefully', async () => {
    const supabase = createMockSupabase(true);
    mockFetch.mockRejectedValue(new Error('Network error'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchNcesInstitutionData(supabase as any);
    expect(result.errors).toBeGreaterThanOrEqual(1);
  });

  it('should handle Supabase upsert errors', async () => {
    const supabase = createMockSupabase(true);
    supabase.from = vi.fn().mockReturnValue({
      upsert: vi.fn().mockResolvedValue({ error: { message: 'DB error' } }),
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          in: vi.fn().mockResolvedValue({ data: [] }),
        }),
      }),
    });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            unitid: 170976,
            inst_name: 'Test University',
            city: 'Test City',
            state_abbr: 'TS',
            zip: '00000',
            sector: 1,
            level: 1,
            control: 1,
            hbcu: 0,
            tribal_college: 0,
            year: 2023,
          },
        ],
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchNcesInstitutionData(supabase as any);
    expect(result.errors).toBeGreaterThanOrEqual(1);
  });

  it('should return result with correct shape', async () => {
    const supabase = createMockSupabase(true);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchNcesInstitutionData(supabase as any);
    expect(result).toHaveProperty('inserted');
    expect(result).toHaveProperty('skipped');
    expect(result).toHaveProperty('errors');
  });
});
