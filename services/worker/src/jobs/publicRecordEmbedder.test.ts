/**
 * Tests for publicRecordEmbedder — ARKOVA-WORKER-M fix + SCRUM-2203 / mig 0345 timeout fix.
 *
 * Validates that RPC errors are propagated (not swallowed) so the cron
 * wrapper can return 500 and Sentry captures the real root cause, and that
 * the un-embedded fetch is always issued through the bounded RPC
 * (get_unembedded_public_records with p_limit = EMBED_BATCH_SIZE) — the property
 * that, together with the partial index added in mig 0345, keeps the fetch under
 * statement_timeout instead of 500ing every ~2 min (err 57014).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks ----

const mockRpc = vi.fn();
const mockInsert = vi.fn();
const mockFrom = vi.fn(() => ({ insert: mockInsert }));
vi.mock('../utils/db.js', () => ({
  db: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

// SUT calls aiProvider.generateEmbedding(text, taskType) (singular) — mock that exact method.
const mockGenerateEmbedding = vi.fn();
vi.mock('../ai/factory.js', () => ({
  createEmbeddingProvider: vi.fn(() => ({
    generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
  })),
}));

vi.mock('../ai/gemini-config.js', () => ({
  GEMINI_EMBEDDING_MODEL: 'text-embedding-004',
}));

vi.mock('../config.js', () => ({
  config: { batchAnchorMaxSize: undefined },
}));

vi.mock('./anchor-batching.js', () => ({
  resolveAnchorBatchSize: vi.fn(() => 500),
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---- SUT ----

import { embedPublicRecords, EMBED_BATCH_SIZE } from './publicRecordEmbedder.js';

describe('embedPublicRecords', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockResolvedValue({ error: null });
  });

  it('throws on RPC fetch error instead of silently returning empty (ARKOVA-WORKER-M)', async () => {
    // Switchboard flag enabled
    mockRpc.mockResolvedValueOnce({ data: true, error: null });
    // RPC returns 500
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'Internal Server Error', code: '500' },
    });

    await expect(embedPublicRecords()).rejects.toThrow(
      'RPC get_unembedded_public_records failed: Internal Server Error',
    );
  });

  it('surfaces a statement-timeout (57014) from the fetch RPC instead of swallowing it (SCRUM-2203 regression)', async () => {
    mockRpc.mockResolvedValueOnce({ data: true, error: null }); // flag enabled
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'canceling statement due to statement timeout', code: '57014' },
    });

    await expect(embedPublicRecords()).rejects.toThrow(
      'RPC get_unembedded_public_records failed: canceling statement due to statement timeout',
    );
  });

  it('returns empty result when embedding flag is disabled', async () => {
    mockRpc.mockResolvedValueOnce({ data: false, error: null });

    const result = await embedPublicRecords();
    expect(result).toEqual({ total: 0, succeeded: 0, failed: 0, errors: [] });
  });

  it('returns empty result when no unembedded records exist', async () => {
    mockRpc.mockResolvedValueOnce({ data: true, error: null }); // flag enabled
    mockRpc.mockResolvedValueOnce({ data: [], error: null });   // no records

    const result = await embedPublicRecords();
    expect(result).toEqual({ total: 0, succeeded: 0, failed: 0, errors: [] });
  });

  it('fetches the unembedded batch through the bounded RPC (LIMIT = EMBED_BATCH_SIZE) so the query never goes unbounded (mig 0345)', async () => {
    mockRpc.mockResolvedValueOnce({ data: true, error: null }); // flag enabled
    mockRpc.mockResolvedValueOnce({ data: [], error: null });   // no records

    await embedPublicRecords();

    // Second rpc call is the fetch; it must pass a bounded p_limit equal to the batch size.
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'get_unembedded_public_records', {
      p_limit: EMBED_BATCH_SIZE,
    });
    expect(EMBED_BATCH_SIZE).toBeGreaterThan(0);
  });

  it('embeds each returned record and inserts the embedding (happy path — Trigger-A: 200 + records embedded)', async () => {
    mockRpc.mockResolvedValueOnce({ data: true, error: null }); // flag enabled
    mockRpc.mockResolvedValueOnce({
      data: [
        { id: 'rec-1', title: 'Patent A', source: 'uspto', record_type: 'patent', metadata: { abstract: 'x' } },
        { id: 'rec-2', title: 'Reg B', source: 'federal_register', record_type: 'regulation', metadata: {} },
      ],
      error: null,
    });
    mockGenerateEmbedding.mockResolvedValue({ embedding: [0.1, 0.2, 0.3] });

    const result = await embedPublicRecords();

    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(2);
    expect(mockFrom).toHaveBeenCalledWith('public_record_embeddings');
    expect(mockInsert).toHaveBeenCalledTimes(2);
    // Inserted rows carry the parent record id (the trigger in 0345 keys embedded_at off this).
    const insertedIds = mockInsert.mock.calls
      .map((c) => (c[0] as { public_record_id: string }).public_record_id)
      .sort();
    expect(insertedIds).toEqual(['rec-1', 'rec-2']);
    expect(result).toEqual(
      expect.objectContaining({ total: 2, succeeded: 2, failed: 0 }),
    );
  });
});
