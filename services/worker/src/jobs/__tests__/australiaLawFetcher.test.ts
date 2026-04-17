/**
 * KAU-03/04: Australia Compliance Data Fetcher Tests
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
          // getExistingSourceIds calls .in(); jurisdiction-filter path uses .eq().limit().
          in: vi.fn().mockResolvedValue({ data: [] }),
          eq: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue({ data: [] }),
          })),
        })),
      })),
      upsert: mockUpsert.mockResolvedValue({ error: null }),
    })),
  };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('Australia Compliance Data Fetcher (KAU-03/04)', () => {
  it('returns early when flag is disabled', async () => {
    mockRpc.mockResolvedValue({ data: false });
    const { fetchAustraliaComplianceData } = await import('../australiaLawFetcher.js');
    const result = await fetchAustraliaComplianceData(createMockSupabase() as any);
    expect(result.statutesInserted).toBe(0);
  });

  it('ingests Australian statutes when flag is enabled', async () => {
    mockRpc.mockResolvedValue({ data: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, text: async () => '', json: async () => ({ results: [] }),
    }));

    const { fetchAustraliaComplianceData } = await import('../australiaLawFetcher.js');
    const result = await fetchAustraliaComplianceData(createMockSupabase() as any);

    // 31 sections across Privacy Act + APP + NDB
    expect(result.statutesInserted).toBeGreaterThan(0);
    expect(mockUpsert).toHaveBeenCalled();

    const firstBatch = mockUpsert.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(firstBatch[0]).toMatchObject({ source: 'australia_law', record_type: 'regulation' });
    expect((firstBatch[0].metadata as Record<string, unknown>).jurisdiction).toBe('Australia');
  });
});
