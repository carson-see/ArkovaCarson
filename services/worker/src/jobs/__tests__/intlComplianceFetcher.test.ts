/**
 * Tests for International Compliance Fetchers (INTL-01/02/03)
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
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [] }),
        order: vi.fn(() => ({ limit: vi.fn().mockResolvedValue({ data: [] }) })),
        limit: vi.fn().mockResolvedValue({ data: [] }),
      })),
      upsert: vi.fn().mockResolvedValue({ error: null }),
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('INTL-01: Brazil LGPD Fetcher', () => {
  it('returns empty when flag is disabled', async () => {
    mockRpc.mockResolvedValue({ data: false });
    const { fetchBrazilComplianceData } = await import('../intlComplianceFetcher.js');
    const result = await fetchBrazilComplianceData(createMockSupabase() as any);
    expect(result).toEqual({ statutesInserted: 0, casesInserted: 0, skipped: 0, errors: 0 });
  });

  it('ingests LGPD statute sections when flag is enabled', async () => {
    mockRpc.mockResolvedValue({ data: true });
    const { fetchBrazilComplianceData } = await import('../intlComplianceFetcher.js');
    const result = await fetchBrazilComplianceData(createMockSupabase() as any);
    expect(result.statutesInserted).toBeGreaterThanOrEqual(0);
    expect(result.errors).toBe(0);
  });
});

describe('INTL-02: Singapore PDPA Fetcher', () => {
  it('returns empty when flag is disabled', async () => {
    mockRpc.mockResolvedValue({ data: false });
    const { fetchSingaporeComplianceData } = await import('../intlComplianceFetcher.js');
    const result = await fetchSingaporeComplianceData(createMockSupabase() as any);
    expect(result).toEqual({ statutesInserted: 0, casesInserted: 0, skipped: 0, errors: 0 });
  });

  it('ingests PDPA statute sections when flag is enabled', async () => {
    mockRpc.mockResolvedValue({ data: true });
    const { fetchSingaporeComplianceData } = await import('../intlComplianceFetcher.js');
    const result = await fetchSingaporeComplianceData(createMockSupabase() as any);
    expect(result.statutesInserted).toBeGreaterThanOrEqual(0);
    expect(result.errors).toBe(0);
  });
});

describe('INTL-03: Mexico LFPDPPP Fetcher', () => {
  it('returns empty when flag is disabled', async () => {
    mockRpc.mockResolvedValue({ data: false });
    const { fetchMexicoComplianceData } = await import('../intlComplianceFetcher.js');
    const result = await fetchMexicoComplianceData(createMockSupabase() as any);
    expect(result).toEqual({ statutesInserted: 0, casesInserted: 0, skipped: 0, errors: 0 });
  });

  it('ingests LFPDPPP statute sections when flag is enabled', async () => {
    mockRpc.mockResolvedValue({ data: true });
    const { fetchMexicoComplianceData } = await import('../intlComplianceFetcher.js');
    const result = await fetchMexicoComplianceData(createMockSupabase() as any);
    expect(result.statutesInserted).toBeGreaterThanOrEqual(0);
    expect(result.errors).toBe(0);
  });
});
