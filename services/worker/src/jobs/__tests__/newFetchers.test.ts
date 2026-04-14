/**
 * Unit tests for NPH-05–10 new pipeline fetchers.
 * Tests the gate-check (ENABLE_PUBLIC_RECORDS_INGESTION flag) for each.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

vi.mock('../../config.js', () => ({
  config: { logLevel: 'info', nodeEnv: 'test' },
}));

vi.mock('../../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../../utils/db.js', () => ({ db: {} }));

function createMockSupabase() {
  return {
    rpc: mockRpc,
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: vi.fn(() => ({ limit: vi.fn().mockResolvedValue({ data: [] }) })),
          limit: vi.fn().mockResolvedValue({ data: [], count: 0 }),
        })),
      })),
      upsert: vi.fn().mockResolvedValue({ error: null }),
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('NPH-05: SOS Fetcher', () => {
  it('returns empty when flag is disabled', async () => {
    mockRpc.mockResolvedValue({ data: false });
    const { fetchSosEntities } = await import('../sosFetcher.js');
    const result = await fetchSosEntities(createMockSupabase() as any);
    expect(result).toEqual([]);
  });
});

describe('NPH-06: Licensing Board Fetcher', () => {
  it('returns empty when flag is disabled', async () => {
    mockRpc.mockResolvedValue({ data: false });
    const { fetchLicensingBoardRecords } = await import('../licensingBoardFetcher.js');
    const result = await fetchLicensingBoardRecords(createMockSupabase() as any);
    expect(result).toEqual([]);
  });
});

describe('NPH-07: Insurance License Fetcher', () => {
  it('returns empty when flag is disabled', async () => {
    mockRpc.mockResolvedValue({ data: false });
    const { fetchInsuranceLicenses } = await import('../insuranceLicenseFetcher.js');
    const result = await fetchInsuranceLicenses(createMockSupabase() as any);
    expect(result).toEqual([]);
  });
});

describe('NPH-08: CLE Fetcher', () => {
  it('returns empty when flag is disabled', async () => {
    mockRpc.mockResolvedValue({ data: false });
    const { fetchCleRecords } = await import('../cleFetcher.js');
    const result = await fetchCleRecords(createMockSupabase() as any);
    expect(result).toEqual([]);
  });
});

describe('NPH-09: Certification Fetcher', () => {
  it('returns empty when flag is disabled', async () => {
    mockRpc.mockResolvedValue({ data: false });
    const { fetchCertificationRecords } = await import('../certificationFetcher.js');
    const result = await fetchCertificationRecords(createMockSupabase() as any);
    expect(result).toEqual([]);
  });
});

describe('NPH-10: IPEDS Fetcher', () => {
  it('returns zeros when flag is disabled', async () => {
    mockRpc.mockResolvedValue({ data: false });
    const { fetchIpedsInstitutions } = await import('../ipedsFetcher.js');
    const result = await fetchIpedsInstitutions(createMockSupabase() as any);
    expect(result).toEqual({ inserted: 0, skipped: 0, errors: 0, total: 0 });
  });
});
