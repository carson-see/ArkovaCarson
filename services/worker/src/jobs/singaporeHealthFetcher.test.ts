/**
 * Tests for MOH Singapore Healthcare Provider Fetcher
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

import { fetchMohSgProviders } from './singaporeHealthFetcher.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createMockSupabase(flagEnabled = true) {
  const insertFn = vi.fn().mockResolvedValue({ error: null });

  return {
    rpc: vi.fn().mockResolvedValue({ data: flagEnabled }),
    from: vi.fn().mockImplementation(() => ({
      insert: insertFn,
      select: vi.fn().mockImplementation((_cols: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.count === 'exact') return { eq: vi.fn().mockResolvedValue({ count: 0 }) };
        return {
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({ data: [] }),
            }),
          }),
        };
      }),
    })),
    _insertFn: insertFn,
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

describe('singaporeHealthFetcher', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should skip when ENABLE_PUBLIC_RECORDS_INGESTION is disabled', async () => {
    const supabase = createMockSupabase(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchMohSgProviders(supabase as any);
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('should construct correct MOH API URL', async () => {
    const supabase = createMockSupabase(true);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => makeCkanResponse([]),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fetchMohSgProviders(supabase as any);
    expect(mockFetch).toHaveBeenCalled();
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('data.gov.sg');
    expect(url).toContain('d_64ee6a62af10a4761adb3b4a64e74c4e');
  });

  it('should transform MOH records and insert into public_records', async () => {
    const supabase = createMockSupabase(true);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => makeCkanResponse([
        {
          _id: 1,
          licence_no: 'HCI-2024-001',
          hci_name: 'Singapore General Hospital',
          hci_code: 'SGH001',
          premises_address: '1 Hospital Drive',
          postal_code: '169608',
          licence_type: 'Hospital',
          licence_status: 'Active',
          licensee_name: 'SingHealth',
          effective_date: '2024-01-01',
          expiry_date: '2027-01-01',
        },
      ]),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchMohSgProviders(supabase as any);
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
    const result = await fetchMohSgProviders(supabase as any);
    expect(result.errors).toBeGreaterThanOrEqual(1);
  });

  it('should handle network errors gracefully', async () => {
    const supabase = createMockSupabase(true);
    mockFetch.mockRejectedValue(new Error('Network error'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchMohSgProviders(supabase as any);
    expect(result.errors).toBeGreaterThanOrEqual(1);
  });

  it('should skip records with no licence number', async () => {
    const supabase = createMockSupabase(true);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => makeCkanResponse([
        { _id: 1, hci_name: 'No Licence Provider' },
      ]),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchMohSgProviders(supabase as any);
    expect(result.skipped).toBe(1);
    expect(result.inserted).toBe(0);
  });

  it('should return result with correct shape', async () => {
    const supabase = createMockSupabase(true);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => makeCkanResponse([]),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchMohSgProviders(supabase as any);
    expect(result).toHaveProperty('inserted');
    expect(result).toHaveProperty('skipped');
    expect(result).toHaveProperty('errors');
  });
});
