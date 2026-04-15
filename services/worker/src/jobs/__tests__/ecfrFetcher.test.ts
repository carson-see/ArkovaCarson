/**
 * NCX-01: eCFR Regulatory Text Fetcher Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
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
          limit: vi.fn().mockResolvedValue({ data: [] }),
        })),
      })),
      upsert: vi.fn().mockResolvedValue({ error: null }),
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('eCFR Fetcher (NCX-01)', () => {
  it('returns early when flag is disabled', async () => {
    mockRpc.mockResolvedValue({ data: false });
    const { fetchEcfrRegulations } = await import('../ecfrFetcher.js');
    const result = await fetchEcfrRegulations(createMockSupabase() as any);
    expect(result.inserted).toBe(0);
    expect(result.titlesProcessed).toBe(0);
  });

  it('fetches structure and text when flag is enabled', async () => {
    mockRpc.mockResolvedValue({ data: true });

    // Mock eCFR API — returns structure then section text for each title/part
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/structure/')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            children: [{
              identifier: '99.1',
              label: 'Applicability of part',
              title: 'Applicability',
              reserved: false,
              type: 'section',
            }],
          }),
        });
      }
      if (String(url).includes('/full/')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ content: 'This part applies to educational agencies...' }),
        });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    vi.stubGlobal('fetch', mockFetch);

    const { fetchEcfrRegulations } = await import('../ecfrFetcher.js');
    const result = await fetchEcfrRegulations(createMockSupabase() as any);

    expect(mockFetch).toHaveBeenCalled();
    expect(result.inserted + result.skipped).toBeGreaterThan(0);
  });
});
