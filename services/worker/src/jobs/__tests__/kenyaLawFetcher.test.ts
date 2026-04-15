/**
 * KAU-01/02: Kenya Compliance Data Fetcher Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
const mockUpsert = vi.fn();
const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

vi.mock('../../config.js', () => ({ config: { logLevel: 'info', nodeEnv: 'test' } }));
vi.mock('../../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../../utils/db.js', () => ({ db: {} }));

function createMockSupabase() {
  return {
    rpc: mockRpc,
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue({ data: [] }),
          })),
        })),
      })),
      upsert: mockUpsert.mockResolvedValue({ error: null }),
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Kenya Compliance Data Fetcher (KAU-01/02)', () => {
  it('returns early when flag is disabled', async () => {
    mockRpc.mockResolvedValue({ data: false });
    const { fetchKenyaComplianceData } = await import('../kenyaLawFetcher.js');
    const result = await fetchKenyaComplianceData(createMockSupabase() as any);
    expect(result.statutesInserted).toBe(0);
    expect(result.casesInserted).toBe(0);
  });

  it('ingests Kenya statutes when flag is enabled', async () => {
    mockRpc.mockResolvedValue({ data: true });

    // Mock Kenya Law search (for case law — will return empty)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    }));

    const { fetchKenyaComplianceData } = await import('../kenyaLawFetcher.js');
    const result = await fetchKenyaComplianceData(createMockSupabase() as any);

    // Should insert statute sections (18 sections across 3 statutes)
    expect(result.statutesInserted).toBeGreaterThan(0);
    expect(mockUpsert).toHaveBeenCalled();

    // Verify the upserted records have Kenya metadata
    const firstBatch = mockUpsert.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(firstBatch[0]).toMatchObject({
      source: 'kenya_law',
      record_type: 'regulation',
    });
    expect((firstBatch[0].metadata as Record<string, unknown>).jurisdiction).toBe('Kenya');
  });
});
