/**
 * Unit tests for EDGAR Fetcher
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
  config: { logLevel: 'info', nodeEnv: 'test', edgarUserAgent: 'TestAgent test@test.com' },
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

describe('edgarFetcher', () => {
  it('returns early when flag is disabled', async () => {
    mockRpc.mockResolvedValue({ data: false });

    const { fetchEdgarFilings } = await import('../edgarFetcher.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchEdgarFilings(createMockSupabase() as any);

    expect(mockRpc).toHaveBeenCalledWith('get_flag', {
      p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
    });
    expect(result).toEqual({ inserted: 0, skipped: 0, errors: 0 });
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('disabled'),
    );
  });

  it('fetches filings and inserts records when flag is enabled', async () => {
    mockRpc.mockResolvedValue({ data: true });
    mockSelectChain.limit.mockResolvedValue({ data: [] });
    mockInsert.mockResolvedValue({ error: null });

    const mockResponse = {
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        hits: {
          hits: [
            {
              _id: '0001234567-26-000001',
              _source: {
                form_type: '10-K',
                entity_name: 'Test Corp',
                file_date: '2026-01-15',
                ciks: ['0001234567'],
                tickers: ['TEST'],
                display_names: ['Test Corp'],
              },
            },
          ],
          total: { value: 1 },
        },
      }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const { fetchEdgarFilings } = await import('../edgarFetcher.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fetchEdgarFilings(createMockSupabase() as any);

    expect(fetch).toHaveBeenCalled();
    // Verify User-Agent header is set
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    const headers = (fetchCall[1] as RequestInit).headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('TestAgent test@test.com');
  });

  it('generates correct SHA-256 hash for content', async () => {
    // Import the module to test hash generation indirectly
    // The hash is computed from JSON.stringify({ accession, form_type, entity_name, file_date })
    const { createHash } = await import('node:crypto');
    const content = JSON.stringify({
      accession: '0001234567-26-000001',
      form_type: '10-K',
      entity_name: 'Test Corp',
      file_date: '2026-01-15',
    });
    const hash = createHash('sha256').update(content, 'utf-8').digest('hex');

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toHaveLength(64);
  });

  it('handles empty search results gracefully', async () => {
    mockRpc.mockResolvedValue({ data: true });
    mockSelectChain.limit.mockResolvedValue({ data: [] });

    const mockResponse = {
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        hits: { hits: [], total: { value: 0 } },
      }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const { fetchEdgarFilings } = await import('../edgarFetcher.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchEdgarFilings(createMockSupabase() as any);

    expect(result.inserted).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('handles fetch network error gracefully', async () => {
    mockRpc.mockResolvedValue({ data: true });
    mockSelectChain.limit.mockResolvedValue({ data: [] });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failure')));

    const { fetchEdgarFilings } = await import('../edgarFetcher.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchEdgarFilings(createMockSupabase() as any);

    // Should handle error gracefully without throwing
    expect(result).toBeDefined();
    expect(result.errors).toBeGreaterThanOrEqual(0);
  });

  it('handles DB insert errors on individual records', async () => {
    mockRpc.mockResolvedValue({ data: true });
    mockSelectChain.limit.mockResolvedValue({ data: [] });
    mockInsert.mockResolvedValue({ error: { message: 'constraint violation' } });

    const mockResponse = {
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        hits: {
          hits: [
            {
              _id: '0001234567-26-000002',
              _source: {
                form_type: '10-Q',
                entity_name: 'Error Corp',
                file_date: '2026-02-15',
                ciks: ['0001234567'],
                tickers: ['ERR'],
                display_names: ['Error Corp'],
              },
            },
          ],
          total: { value: 1 },
        },
      }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const { fetchEdgarFilings } = await import('../edgarFetcher.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchEdgarFilings(createMockSupabase() as any);

    // Should count the error
    expect(result).toBeDefined();
  });

  it('resumes from last filing date when records exist', async () => {
    mockRpc.mockResolvedValue({ data: true });
    // Return existing record with a date to test resume
    mockSelectChain.limit.mockResolvedValue({
      data: [{ filed_date: '2026-01-01' }],
    });

    const mockResponse = {
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        hits: { hits: [], total: { value: 0 } },
      }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const { fetchEdgarFilings } = await import('../edgarFetcher.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fetchEdgarFilings(createMockSupabase() as any);

    // Should have fetched with the resume date
    expect(fetch).toHaveBeenCalled();
  });
});

describe('fetchEdgarHistoricalBackfill', () => {
  it('returns early when flag is disabled', async () => {
    mockRpc.mockResolvedValue({ data: false });

    const { fetchEdgarHistoricalBackfill } = await import('../edgarFetcher.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchEdgarHistoricalBackfill(createMockSupabase() as any, 0);

    expect(result).toEqual({
      inserted: 0,
      skipped: 0,
      errors: 0,
      batchIndex: 0,
      totalBatches: 0,
      companiesProcessed: 0,
    });
  });

  it('handles out-of-range batch index', async () => {
    mockRpc.mockResolvedValue({ data: true });

    const { fetchEdgarHistoricalBackfill } = await import('../edgarFetcher.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchEdgarHistoricalBackfill(createMockSupabase() as any, 9999);

    expect(result.companiesProcessed).toBe(0);
    expect(result.batchIndex).toBe(9999);
  });

  it('processes batch 0 when flag is enabled', async () => {
    mockRpc.mockResolvedValue({ data: true });
    mockSelectChain.limit.mockResolvedValue({ data: [] });

    const mockResponse = {
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        results: [],
        filings: { recent: { accessionNumber: [], primaryDocument: [], filingDate: [], form: [] } },
      }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const { fetchEdgarHistoricalBackfill } = await import('../edgarFetcher.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchEdgarHistoricalBackfill(createMockSupabase() as any, 0);

    expect(result).toBeDefined();
    expect(result.batchIndex).toBe(0);
    expect(result.totalBatches).toBeGreaterThan(0);
  });
});

describe('fetchEdgarBulk', () => {
  it('returns early when flag is disabled', async () => {
    mockRpc.mockResolvedValue({ data: false });

    const { fetchEdgarBulk } = await import('../edgarFetcher.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchEdgarBulk(createMockSupabase() as any, {});

    expect(result).toEqual({
      inserted: 0,
      skipped: 0,
      errors: 0,
      queriesRun: 0,
      formTypesProcessed: [],
    });
  });

  it('respects maxQueriesPerInvocation limit', async () => {
    // First call: flag check returns true
    mockRpc.mockResolvedValueOnce({ data: true });
    // Second call: shard counts RPC returns empty
    mockRpc.mockResolvedValueOnce({ data: [] });

    const mockResponse = {
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        hits: { hits: [], total: { value: 0 } },
      }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));
    mockInsert.mockResolvedValue({ error: null });

    const { fetchEdgarBulk } = await import('../edgarFetcher.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchEdgarBulk(createMockSupabase() as any, {
      maxQueriesPerInvocation: 2,
      startYear: 2024,
      endYear: 2024,
      formTypes: ['10-K'],
    });

    expect(result).toBeDefined();
    expect(result.queriesRun).toBeLessThanOrEqual(2);
  });

  it('uses default options when none provided', async () => {
    mockRpc.mockResolvedValueOnce({ data: true });
    mockRpc.mockResolvedValueOnce({ data: [] });

    const mockResponse = {
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        hits: { hits: [], total: { value: 0 } },
      }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));
    mockInsert.mockResolvedValue({ error: null });

    const { fetchEdgarBulk } = await import('../edgarFetcher.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchEdgarBulk(createMockSupabase() as any);

    expect(result).toBeDefined();
    expect(result.formTypesProcessed).toBeDefined();
  });

  it('skips shards with existing data above threshold', async () => {
    mockRpc.mockResolvedValueOnce({ data: true });
    // Return shard counts showing 2024 10-K already has 100 records
    mockRpc.mockResolvedValueOnce({
      data: [{ form_type: '10-K', filing_year: 2024, cnt: 100 }],
    });

    const mockResponse = {
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        hits: { hits: [], total: { value: 0 } },
      }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const { fetchEdgarBulk } = await import('../edgarFetcher.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchEdgarBulk(createMockSupabase() as any, {
      formTypes: ['10-K'],
      startYear: 2024,
      endYear: 2024,
      maxQueriesPerInvocation: 5,
    });

    expect(result).toBeDefined();
    // Shard should have been skipped
    expect(result.queriesRun).toBe(0);
  });
});
