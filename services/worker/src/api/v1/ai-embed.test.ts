/**
 * AI Embedding Endpoint Tests (P8-S11)
 *
 * TDD: Tests for POST /api/v1/ai/embed.
 * No real API calls (Constitution 1.7).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../ai/factory.js', () => ({
  createAIProvider: vi.fn().mockReturnValue({
    name: 'mock',
    generateEmbedding: vi.fn().mockResolvedValue({
      embedding: new Array(768).fill(0.1),
      model: 'text-embedding-004',
    }),
  }),
}));

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
import { generateAndStoreEmbedding } from '../../ai/embeddings.js';

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
  } as unknown as Response;
  return { req, res };
}

describe('POST /api/v1/ai/embed', () => {
  beforeEach(() => vi.clearAllMocks());

  it('generates embedding and returns success', async () => {
    const handler = getHandler('post', '/');
    const { req, res } = createMockReqRes(
      {
        anchorId: '00000000-0000-0000-0000-000000000001',
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
      anchorId: '00000000-0000-0000-0000-000000000001',
      metadata: {},
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns credit error when exhausted', async () => {
    vi.mocked(generateAndStoreEmbedding).mockResolvedValueOnce({
      success: false,
      error: 'Insufficient AI credits for embedding generation',
    });

    const handler = getHandler('post', '/');
    const { req, res } = createMockReqRes(
      {
        anchorId: '00000000-0000-0000-0000-000000000001',
        metadata: { credentialType: 'DEGREE' },
      },
      'user-123',
    );

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(402);
  });
});
