/**
 * Unit tests for EDGAR Fetcher
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeContentHash } from '../edgarFetcher.js';

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

  // select chain: .select().eq().eq().limit() or .select().eq().order().limit()
  const mockLimit = vi.fn();
  const mockOrder = vi.fn(() => ({ limit: mockLimit }));
  const selectChain: Record<string, unknown> = {};
  selectChain.eq = vi.fn(() => selectChain);
  selectChain.order = mockOrder;
  selectChain.limit = mockLimit;

  return { mockRpc, mockInsert, mockSelectChain: { chain: selectChain, limit: mockLimit, order: mockOrder }, mockLogger };
});

// Mock config
vi.mock('../../config.js', () => ({
  config: {
    edgarUserAgent: 'Test Agent test@test.com',
    trainingDataOutputPath: './test-output',
    logLevel: 'info',
    nodeEnv: 'test',
  },
}));

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  logger: mockLogger,
}));

// Build mock supabase client
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
    await fetchEdgarFilings(createMockSupabase() as any);

    expect(mockRpc).toHaveBeenCalledWith('get_flag', {
      p_flag_id: 'ENABLE_PUBLIC_RECORDS_INGESTION',
    });
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('disabled')
    );
  });

  it('fetches filings and inserts records when flag is enabled', async () => {
    mockRpc.mockResolvedValue({ data: true });

    // Resume query returns no prior records
    mockSelectChain.limit.mockResolvedValue({ data: [] });

    // Mock fetch for EDGAR API
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        hits: {
          hits: [
            {
              _id: 'test-filing-1',
              _source: {
                file_date: '2026-01-01',
                display_date_filed: '2026-01-01',
                entity_name: 'Test Corp',
                file_num: '001-12345',
                form_type: '10-K',
                file_description: 'Annual Report',
              },
            },
          ],
          total: { value: 1 },
        },
      }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    // Duplicate check returns empty
    mockSelectChain.limit.mockResolvedValue({ data: [] });

    // Insert succeeds
    mockInsert.mockResolvedValue({ error: null });

    const { fetchEdgarFilings } = await import('../edgarFetcher.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fetchEdgarFilings(createMockSupabase() as any);

    expect(fetch).toHaveBeenCalled();
    expect(mockInsert).toHaveBeenCalled();
  });

  it('generates correct SHA-256 hash', () => {
    const hash = computeContentHash('hello world');
    expect(hash).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
    );
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
