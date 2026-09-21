/**
 * AI Embedding Endpoint Tests (P8-S11)
 *
 * TDD: Tests for POST /api/v1/ai/embed.
 * No real API calls (Constitution 1.7).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../ai/factory.js', () => {
  const mockProvider = {
    name: 'mock',
    generateEmbedding: vi.fn().mockResolvedValue({
      embedding: new Array(768).fill(0.1),
      model: 'text-embedding-004',
    }),
  };
  return {
    createAIProvider: vi.fn().mockReturnValue(mockProvider),
    createEmbeddingProvider: vi.fn().mockReturnValue(mockProvider),
  };
});

vi.mock('../../ai/embeddings.js', () => ({
  generateAndStoreEmbedding: vi.fn().mockResolvedValue({
    success: true,
    model: 'text-embedding-004',
  }),
  batchReEmbed: vi.fn().mockResolvedValue({
    total: 2,
    succeeded: 2,
    failed: 0,
    errors: [],
  }),
}));

vi.mock('../../utils/db.js', () => ({
  db: {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { org_id: 'org-123' },
            error: null,
          }),
        }),
        in: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({
            data: [
              { id: 'a1', metadata: { issuerName: 'Test' }, credential_type: 'DEGREE' },
              { id: 'a2', metadata: null, credential_type: 'CERTIFICATE' },
            ],
            error: null,
          }),
        }),
      }),
    }),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { Request, Response } from 'express';
import { aiEmbedRouter } from './ai-embed.js';
import { generateAndStoreEmbedding, batchReEmbed } from '../../ai/embeddings.js';

function getHandler(method: string, path = '/') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stack = (aiEmbedRouter as any).stack;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = stack.find((l: any) => l.route?.path === path && l.route?.methods?.[method]);
  return layer?.route?.stack[0].handle;
}

function createMockReqRes(body: Record<string, unknown> = {}, authUserId?: string) {
  const req = { authUserId, body, query: {}, method: 'POST', url: '/' } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

describe('POST /api/v1/ai/embed', () => {
  beforeEach(() => vi.clearAllMocks());

  it('generates embedding and returns success', async () => {
    const handler = getHandler('post', '/');
    const { req, res } = createMockReqRes(
      {
        anchorId: '10000000-1000-4000-8000-000000000001',
        metadata: { credentialType: 'DEGREE', issuerName: 'Test University' },
      },
      'user-123',
    );

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, model: 'text-embedding-004' }),
    );
    expect(generateAndStoreEmbedding).toHaveBeenCalled();
  });

  it('returns 400 for invalid anchor ID', async () => {
    const handler = getHandler('post', '/');
    const { req, res } = createMockReqRes(
      { anchorId: 'not-a-uuid', metadata: {} },
      'user-123',
    );

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 401 without auth', async () => {
    const handler = getHandler('post', '/');
    const { req, res } = createMockReqRes({
      anchorId: '10000000-1000-4000-8000-000000000001',
      metadata: {},
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns credit error when exhausted', async () => {
    vi.mocked(generateAndStoreEmbedding).mockResolvedValueOnce({
      success: false,
      code: 'insufficient_credits',
      error: 'Insufficient AI credits for embedding generation',
    });

    const handler = getHandler('post', '/');
    const { req, res } = createMockReqRes(
      {
        anchorId: '10000000-1000-4000-8000-000000000001',
        metadata: { credentialType: 'DEGREE' },
      },
      'user-123',
    );

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'insufficient_credits' }),
    );
  });
});

/**
 * B1 — the route used to decide the status by asking whether the failure
 * MESSAGE contained the substring "credit":
 *
 *     const status = result.error?.includes('credit') ? 402 : 500;
 *
 * So a 55P03 lock timeout on `deduct_ai_credits`, or the RPC being down
 * entirely, told the customer they were out of credits and should buy more —
 * for a failure that is ours and retryable. The result now carries a typed
 * `code` and the route branches on that; the substring test is gone.
 *
 * The reasoning mirrors `ai-extract.ts`: "503, not 402 — `insufficient_credits`
 * would tell the caller to buy more when `checkAICredits` just reported that
 * they have some. The failure is ours and it is retryable."
 */
describe('POST /api/v1/ai/embed — credit failures are classified by code, not by message text', () => {
  beforeEach(() => vi.clearAllMocks());

  const body = {
    anchorId: '10000000-1000-4000-8000-000000000001',
    metadata: { credentialType: 'DEGREE' },
  };

  it('answers 503 + Retry-After when the debit RPC is unavailable (55P03)', async () => {
    vi.mocked(generateAndStoreEmbedding).mockResolvedValueOnce({
      success: false,
      code: 'credit_debit_unavailable',
      error: 'AI credit debit failed — refusing to keep an uncharged embedding',
    });

    const handler = getHandler('post', '/');
    const { req, res } = createMockReqRes(body, 'user-123');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.status).not.toHaveBeenCalledWith(402);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '5');
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'credit_system_unavailable' }),
    );
  });

  it('answers 503 when the credit pre-check RPC is unavailable', async () => {
    vi.mocked(generateAndStoreEmbedding).mockResolvedValueOnce({
      success: false,
      code: 'credit_check_unavailable',
      error: 'credit service unavailable',
    });

    const handler = getHandler('post', '/');
    const { req, res } = createMockReqRes(body, 'user-123');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '5');
  });

  it('answers 500 for a provider failure whose message merely contains "credit"', async () => {
    vi.mocked(generateAndStoreEmbedding).mockResolvedValueOnce({
      success: false,
      code: 'embedding_failed',
      error: 'credential credit scoring model timed out',
    });

    const handler = getHandler('post', '/');
    const { req, res } = createMockReqRes(body, 'user-123');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'embedding_failed' }),
    );
  });

  it('answers 500 for a storage failure', async () => {
    vi.mocked(generateAndStoreEmbedding).mockResolvedValueOnce({
      success: false,
      code: 'database_error',
      error: 'Database error: upsert denied',
    });

    const handler = getHandler('post', '/');
    const { req, res } = createMockReqRes(body, 'user-123');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('POST /api/v1/ai/embed/batch — whole-batch credit failures carry the right status', () => {
  beforeEach(() => vi.clearAllMocks());

  const body = {
    anchorIds: [
      '10000000-1000-4000-8000-000000000001',
      '10000000-1000-4000-8000-000000000002',
    ],
  };

  it('answers 503 + Retry-After when every row failed on an unavailable debit', async () => {
    vi.mocked(batchReEmbed).mockResolvedValueOnce({
      total: 2,
      succeeded: 0,
      failed: 2,
      errors: [
        { anchorId: 'a1', error: 'AI credit debit failed', code: 'credit_debit_unavailable' },
        { anchorId: 'a2', error: 'AI credit debit failed', code: 'credit_debit_unavailable' },
      ],
    });

    const handler = getHandler('post', '/batch');
    const { req, res } = createMockReqRes(body, 'user-123');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '5');
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'credit_system_unavailable' }),
    );
  });

  it('answers 402 when every row failed on genuine exhaustion', async () => {
    vi.mocked(batchReEmbed).mockResolvedValueOnce({
      total: 2,
      succeeded: 0,
      failed: 2,
      errors: [
        { anchorId: 'a1', error: 'Insufficient AI credits for embedding batch', code: 'insufficient_credits' },
        { anchorId: 'a2', error: 'Insufficient AI credits for embedding batch', code: 'insufficient_credits' },
      ],
    });

    const handler = getHandler('post', '/batch');
    const { req, res } = createMockReqRes(body, 'user-123');

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'insufficient_credits' }),
    );
  });

  it('keeps a partial failure a 200 with the per-row result', async () => {
    vi.mocked(batchReEmbed).mockResolvedValueOnce({
      total: 2,
      succeeded: 1,
      failed: 1,
      errors: [
        { anchorId: 'a2', error: 'AI credit debit failed', code: 'credit_debit_unavailable' },
      ],
    });

    const handler = getHandler('post', '/batch');
    const { req, res } = createMockReqRes(body, 'user-123');

    await handler(req, res);

    expect(res.status).not.toHaveBeenCalledWith(503);
    expect(res.status).not.toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ total: 2, succeeded: 1, failed: 1 }),
    );
  });
});
