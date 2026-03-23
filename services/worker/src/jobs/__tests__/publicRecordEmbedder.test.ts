/**
 * Unit tests for Public Record Batch Embedder
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks ----
const { mockRpc, mockInsert, mockSelectChain, mockLogger, mockAiProvider } = vi.hoisted(() => {
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
  selectChain.not = vi.fn(() => selectChain);
  selectChain.order = mockOrder;
  selectChain.limit = mockLimit;

  const mockAiProvider = {
    generateEmbedding: vi.fn(),
  };

  return { mockRpc, mockInsert, mockSelectChain: { chain: selectChain, limit: mockLimit, order: mockOrder }, mockLogger, mockAiProvider };
});

vi.mock('../../config.js', () => ({
  config: { logLevel: 'info', nodeEnv: 'test', aiProvider: 'mock' },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: mockLogger,
}));

vi.mock('../../utils/db.js', () => ({
  db: {},
}));

vi.mock('../../ai/factory.js', () => ({
  createAIProvider: () => mockAiProvider,
}));

function createMockSupabase(records: Array<Record<string, unknown>> = []) {
  mockSelectChain.limit.mockResolvedValue({ data: records, error: null });
  mockInsert.mockResolvedValue({ error: null });

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
});

describe('publicRecordEmbedder', () => {
  it('returns early when flag is disabled', async () => {
    mockRpc.mockResolvedValue({ data: false });

    const { embedPublicRecords } = await import('../publicRecordEmbedder.js');
    const result = await embedPublicRecords(createMockSupabase() as any);

    expect(result.total).toBe(0);
    expect(mockRpc).toHaveBeenCalledWith('get_flag', {
      p_flag_key: 'ENABLE_PUBLIC_RECORD_EMBEDDINGS',
    });
  });

  it('handles empty result set', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: true })   // get_flag
      .mockResolvedValueOnce({ data: [], error: null }); // get_unembedded_public_records
    const mockSupa = createMockSupabase([]);

    const { embedPublicRecords } = await import('../publicRecordEmbedder.js');
    const result = await embedPublicRecords(mockSupa as any);

    expect(result.total).toBe(0);
    expect(result.succeeded).toBe(0);
  });

  it('generates embeddings for unembedded records', async () => {
    const records = [
      {
        id: 'rec-1',
        title: 'Test Patent',
        source: 'uspto',
        record_type: 'patent_grant',
        metadata: { abstract: 'A test patent' },
      },
    ];
    mockRpc
      .mockResolvedValueOnce({ data: true })   // get_flag
      .mockResolvedValueOnce({ data: records, error: null }); // get_unembedded_public_records
    const mockSupa = createMockSupabase(records);

    mockAiProvider.generateEmbedding.mockResolvedValue({
      embedding: new Array(768).fill(0.1),
    });

    const { embedPublicRecords } = await import('../publicRecordEmbedder.js');
    const result = await embedPublicRecords(mockSupa as any);

    expect(result.total).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(mockAiProvider.generateEmbedding).toHaveBeenCalledOnce();
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        public_record_id: 'rec-1',
        model_version: 'text-embedding-004',
      }),
    );
  });
});
