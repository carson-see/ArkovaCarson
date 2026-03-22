/**
 * Unit tests for USPTO Patent Fetcher
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks ----
const { mockRpc, mockInsert, mockSelectChain, mockLogger } = vi.hoisted(() => {
  const mockRpc = vi.fn();
  const mockInsert = vi.fn();
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const mockLimit = vi.fn();
  const mockOrder = vi.fn(() => ({ limit: mockLimit }));
  const selectChain: Record<string, unknown> = {};
  selectChain.eq = vi.fn(() => selectChain);
  selectChain.order = mockOrder;
  selectChain.limit = mockLimit;

  return { mockRpc, mockInsert, mockSelectChain: { chain: selectChain, limit: mockLimit, order: mockOrder }, mockLogger };
});

vi.mock('../../config.js', () => ({
  config: { logLevel: 'info', nodeEnv: 'test' },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: mockLogger,
}));

function createMockSupabase() {
  return {
    rpc: mockRpc,
    from: vi.fn((_table: string) => ({
      select: vi.fn(() => mockSelectChain.chain),
      insert: mockInsert,
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('usptoFetcher', () => {
  it('returns early when flag is disabled', async () => {
    mockRpc.mockResolvedValue({ data: false });

    const { fetchUsptoPAtents } = await import('../usptoFetcher.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fetchUsptoPAtents(createMockSupabase() as any);

    expect(mockRpc).toHaveBeenCalledWith('get_flag', {
      p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
    });
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('disabled')
    );
  });

  it('fetches patents and inserts records when flag is enabled', async () => {
    mockRpc.mockResolvedValue({ data: true });
    mockSelectChain.limit.mockResolvedValue({ data: [] });
    mockInsert.mockResolvedValue({ error: null });

    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        patents: [
          {
            patent_number: '11234567',
            patent_title: 'Test Patent',
            patent_abstract: 'A test patent abstract',
            patent_date: '2026-01-15',
            patent_type: 'utility',
          },
        ],
        count: 1,
        total_patent_count: 1,
      }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const { fetchUsptoPAtents } = await import('../usptoFetcher.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fetchUsptoPAtents(createMockSupabase() as any);

    expect(fetch).toHaveBeenCalled();
    expect(mockInsert).toHaveBeenCalled();
  });
});
