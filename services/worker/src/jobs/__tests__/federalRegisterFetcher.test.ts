/**
 * Unit tests for Federal Register Fetcher
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

describe('federalRegisterFetcher', () => {
  it('returns early when flag is disabled', async () => {
    mockRpc.mockResolvedValue({ data: false });

    const { fetchFederalRegisterDocuments } = await import('../federalRegisterFetcher.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fetchFederalRegisterDocuments(createMockSupabase() as any);

    expect(mockRpc).toHaveBeenCalledWith('get_flag', {
      p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
    });
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('disabled')
    );
  });

  it('fetches documents and inserts records when flag is enabled', async () => {
    mockRpc.mockResolvedValue({ data: true });
    mockSelectChain.limit.mockResolvedValue({ data: [] });
    mockInsert.mockResolvedValue({ error: null });

    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        count: 1,
        total_pages: 1,
        next_page_url: null,
        results: [
          {
            document_number: '2026-01234',
            title: 'Test Proposed Rule',
            type: 'Proposed Rule',
            abstract: 'A test regulatory document',
            publication_date: '2026-03-01',
            html_url: 'https://www.federalregister.gov/d/2026-01234',
            pdf_url: 'https://www.govinfo.gov/content/pkg/FR-2026-03-01/pdf/2026-01234.pdf',
            agencies: [{ name: 'Securities and Exchange Commission', id: 466 }],
            citation: '91 FR 12345',
          },
        ],
      }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const { fetchFederalRegisterDocuments } = await import('../federalRegisterFetcher.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fetchFederalRegisterDocuments(createMockSupabase() as any);

    expect(fetch).toHaveBeenCalled();
    expect(mockInsert).toHaveBeenCalled();
  });

  it('handles empty result set', async () => {
    mockRpc.mockResolvedValue({ data: true });
    mockSelectChain.limit.mockResolvedValue({ data: [] });

    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        count: 0,
        total_pages: 0,
        next_page_url: null,
        results: [],
      }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const { fetchFederalRegisterDocuments } = await import('../federalRegisterFetcher.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fetchFederalRegisterDocuments(createMockSupabase() as any);

    expect(mockInsert).not.toHaveBeenCalled();
  });
});
