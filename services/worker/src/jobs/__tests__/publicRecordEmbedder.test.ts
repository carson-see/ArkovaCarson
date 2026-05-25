/**
 * Unit tests for Public Record Batch Embedder
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockSupabase } from './__testHelpers.js';

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
  createEmbeddingProvider: () => mockAiProvider,
}));

function makeMock(records: Array<Record<string, unknown>> = []) {
  mockSelectChain.limit.mockResolvedValue({ data: records, error: null });
  mockInsert.mockResolvedValue({ error: null });

  return createMockSupabase({
    rpcMock: mockRpc,
    fromImpl: vi.fn((_table: string) => ({
      select: vi.fn(() => mockSelectChain.chain),
      insert: mockInsert,
    })),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('publicRecordEmbedder', () => {
  it('uses the shared 10k pipeline batch cap', async () => {
    const { EMBED_BATCH_SIZE } = await import('../publicRecordEmbedder.js');
    expect(EMBED_BATCH_SIZE).toBe(10_000);
  });

  it('returns early when flag is disabled', async () => {
    mockRpc.mockResolvedValue({ data: false });

    const { embedPublicRecords } = await import('../publicRecordEmbedder.js');
    const result = await embedPublicRecords(makeMock().client);

    expect(result.total).toBe(0);
    expect(mockRpc).toHaveBeenCalledWith('get_flag', {
      p_flag_key: 'ENABLE_PUBLIC_RECORD_EMBEDDINGS',
    });
  });

  it('handles empty result set', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: true })
      .mockResolvedValueOnce({ data: [], error: null });

    const { embedPublicRecords } = await import('../publicRecordEmbedder.js');
    const result = await embedPublicRecords(makeMock([]).client);

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
      .mockResolvedValueOnce({ data: true })
      .mockResolvedValueOnce({ data: records, error: null });

    mockAiProvider.generateEmbedding.mockResolvedValue({
      embedding: new Array(768).fill(0.1),
    });

    const { embedPublicRecords } = await import('../publicRecordEmbedder.js');
    const result = await embedPublicRecords(makeMock(records).client);

    expect(result.total).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(mockAiProvider.generateEmbedding).toHaveBeenCalledOnce();
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        public_record_id: 'rec-1',
        model_version: 'gemini-embedding-001',
      }),
    );
  });
});
