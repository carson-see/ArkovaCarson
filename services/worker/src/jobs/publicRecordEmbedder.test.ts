/**
 * Tests for publicRecordEmbedder — ARKOVA-WORKER-M fix.
 *
 * Validates that RPC errors are propagated (not swallowed) so the cron
 * wrapper can return 500 and Sentry captures the real root cause.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks ----

const mockRpc = vi.fn();
vi.mock('../utils/db.js', () => ({
  db: { rpc: (...args: unknown[]) => mockRpc(...args) },
}));

vi.mock('../ai/factory.js', () => ({
  createEmbeddingProvider: vi.fn(() => ({
    generateEmbeddings: vi.fn(),
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

import { embedPublicRecords } from './publicRecordEmbedder.js';

describe('embedPublicRecords', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
