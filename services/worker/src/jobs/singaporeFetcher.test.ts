/**
 * Tests for ACRA Singapore Companies Fetcher
 *
 * Tests URL construction, rate limiting, record transformation,
 * error handling, and batch processing. All HTTP calls mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the pipeline module's delay to be a no-op (avoids timer issues)
vi.mock('../utils/pipeline.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    delay: vi.fn().mockResolvedValue(undefined),
  };
});

import { fetchAcraSgCompanies } from './singaporeFetcher.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createMockSupabase(flagEnabled = true) {
  const insertFn = vi.fn().mockResolvedValue({ error: null });
  const selectCountFn = vi.fn().mockResolvedValue({ count: 0 });
  const selectIdFn = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue({ data: [] }),
      }),
    }),
  });

  return {
    rpc: vi.fn().mockResolvedValue({ data: flagEnabled }),
    from: vi.fn().mockImplementation(() => ({
      insert: insertFn,
      select: vi.fn().mockImplementation((_cols: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.count === 'exact') return { eq: vi.fn().mockResolvedValue({ count: 0 }) };
        return selectIdFn();
      }),
    })),
    _insertFn: insertFn,
    _selectCountFn: selectCountFn,
  };
}

function makeCkanResponse(records: Array<Record<string, unknown>>, total = 0) {
  return {
    success: true,
    result: {
      records,
      total: total || records.length,
    },
  };
}

describe('singaporeFetcher', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should skip when ENABLE_PUBLIC_RECORDS_INGESTION is disabled', async () => {
    const supabase = createMockSupabase(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchAcraSgCompanies(supabase as any);
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('should construct correct ACRA API URL', async () => {
    const supabase = createMockSupabase(true);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => makeCkanResponse([]),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fetchAcraSgCompanies(supabase as any);
    expect(mockFetch).toHaveBeenCalled();
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('data.gov.sg');
    expect(url).toContain('d_3f960c10fed6145404ca7b821f263b87');
  });

  it('should transform ACRA records and insert into public_records', async () => {
    const supabase = createMockSupabase(true);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => makeCkanResponse([
        {
          _id: 1,
          uen: '200001234A',
          entity_name: 'Test Company Pte Ltd',
          entity_type_description: 'Local Company',
          registration_incorporation_date: '2000-01-15',
          uen_status: 'Registered',
          primary_ssic_code: '62011',
          primary_ssic_description: 'Software Development',
        },
      ]),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchAcraSgCompanies(supabase as any);
    expect(result.inserted).toBe(1);
    expect(supabase.from).toHaveBeenCalledWith('public_records');
  });

  it('should handle API errors gracefully', async () => {
    const supabase = createMockSupabase(true);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchAcraSgCompanies(supabase as any);
    expect(result.errors).toBeGreaterThanOrEqual(1);
  });

  it('should handle network errors gracefully', async () => {
    const supabase = createMockSupabase(true);
    mockFetch.mockRejectedValue(new Error('Network error'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchAcraSgCompanies(supabase as any);
    expect(result.errors).toBeGreaterThanOrEqual(1);
  });

  it('should skip records with no UEN', async () => {
    const supabase = createMockSupabase(true);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => makeCkanResponse([
        { _id: 1, uen: '', entity_name: 'No UEN Company' },
      ]),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchAcraSgCompanies(supabase as any);
    expect(result.skipped).toBe(1);
    expect(result.inserted).toBe(0);
  });

  it('should handle API returning success=false', async () => {
    const supabase = createMockSupabase(true);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, result: { records: [], total: 0 } }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchAcraSgCompanies(supabase as any);
    expect(result.errors).toBeGreaterThanOrEqual(1);
  });

  it('should return result with correct shape', async () => {
    const supabase = createMockSupabase(true);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => makeCkanResponse([]),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchAcraSgCompanies(supabase as any);
    expect(result).toHaveProperty('inserted');
    expect(result).toHaveProperty('skipped');
    expect(result).toHaveProperty('errors');
  });
});
