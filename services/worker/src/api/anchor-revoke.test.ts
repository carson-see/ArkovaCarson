import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/db.js', () => {
  const mockSingle = vi.fn();
  const mockInsert = vi.fn().mockResolvedValue({ error: null });
  const mockRpc = vi.fn().mockResolvedValue({ error: null });
  return {
    db: {
      from: vi.fn((table: string) => {
        if (table === 'anchors') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: mockSingle,
          };
        }
        return { insert: mockInsert };
      }),
      rpc: mockRpc,
    },
    __mockSingle: mockSingle,
    __mockRpc: mockRpc,
  };
});

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../notifications/dispatcher.js', () => ({
  emitNotification: vi.fn(),
}));

import express from 'express';
import request from 'supertest';
import { anchorRevokeRouter } from './anchor-revoke.js';
import { db } from '../utils/db.js';

const { __mockSingle: mockSingle, __mockRpc: mockRpc } = await import('../utils/db.js') as any;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/anchor', anchorRevokeRouter);
  return app;
}

describe('POST /api/anchor/:id/revoke', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSingle.mockResolvedValue({
      data: { id: 'a1', status: 'SECURED', org_id: 'org1', user_id: 'u1' },
      error: null,
    });
  });

  it('revokes a SECURED anchor', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/a1/revoke')
      .send({ reason: 'Document expired' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('REVOKED');
    expect(mockRpc).toHaveBeenCalledWith('revoke_anchor', {
      anchor_id: 'a1',
      reason: 'Document expired',
    });
  });

  it('rejects missing reason', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/a1/revoke')
      .send({});

    expect(res.status).toBe(400);
  });

  it('rejects non-SECURED anchor', async () => {
    mockSingle.mockResolvedValueOnce({
      data: { id: 'a1', status: 'PENDING', org_id: 'org1', user_id: 'u1' },
      error: null,
    });

    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/a1/revoke')
      .send({ reason: 'Test' });

    expect(res.status).toBe(409);
  });

  it('returns 404 for missing anchor', async () => {
    mockSingle.mockResolvedValueOnce({ data: null, error: { message: 'not found' } });

    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/nonexistent/revoke')
      .send({ reason: 'Test' });

    expect(res.status).toBe(404);
  });

  it('returns 500 on RPC failure', async () => {
    mockRpc.mockResolvedValueOnce({ error: { message: 'RPC failed' } });

    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/a1/revoke')
      .send({ reason: 'Test' });

    expect(res.status).toBe(500);
  });
});
