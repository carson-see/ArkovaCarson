import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/db.js', () => {
  const _mockAnchorSingle = vi.fn();
  const _mockMembershipSingle = vi.fn();
  const _mockInsert = vi.fn().mockResolvedValue({ error: null });
  const _mockRpc = vi.fn().mockResolvedValue({ error: null });
  return {
    db: {
      from: vi.fn((table: string) => {
        if (table === 'anchors') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: _mockAnchorSingle,
          };
        }
        if (table === 'org_memberships') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: _mockMembershipSingle,
          };
        }
        return { insert: _mockInsert };
      }),
      rpc: _mockRpc,
    },
    __mockAnchorSingle: _mockAnchorSingle,
    __mockMembershipSingle: _mockMembershipSingle,
    __mockRpc: _mockRpc,
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

const {
  __mockAnchorSingle: mockAnchorSingle,
  __mockMembershipSingle: mockMembershipSingle,
  __mockRpc: mockRpc,
} = await import('../utils/db.js') as any;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).userId = 'u1';
    next();
  });
  app.use('/api/anchor', anchorRevokeRouter);
  return app;
}

describe('POST /api/anchor/:id/revoke', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAnchorSingle.mockResolvedValue({
      data: { id: '11111111-1111-1111-1111-111111111111', status: 'SECURED', org_id: 'org1', user_id: 'u1' },
      error: null,
    });
    mockMembershipSingle.mockResolvedValue({
      data: { role: 'ORG_ADMIN' },
      error: null,
    });
  });

  it('revokes a SECURED anchor', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/11111111-1111-1111-1111-111111111111/revoke')
      .send({ reason: 'Document expired' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('REVOKED');
    expect(mockRpc).toHaveBeenCalledWith('revoke_anchor', {
      anchor_id: '11111111-1111-1111-1111-111111111111',
      reason: 'Document expired',
    });
  });

  it('rejects missing reason', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/11111111-1111-1111-1111-111111111111/revoke')
      .send({});

    expect(res.status).toBe(400);
  });

  it('rejects non-SECURED anchor', async () => {
    mockAnchorSingle.mockResolvedValueOnce({
      data: { id: '11111111-1111-1111-1111-111111111111', status: 'PENDING', org_id: 'org1', user_id: 'u1' },
      error: null,
    });

    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/11111111-1111-1111-1111-111111111111/revoke')
      .send({ reason: 'Test' });

    expect(res.status).toBe(409);
  });

  it('returns 404 for missing anchor', async () => {
    mockAnchorSingle.mockResolvedValueOnce({ data: null, error: { message: 'not found' } });

    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/22222222-2222-2222-2222-222222222222/revoke')
      .send({ reason: 'Test' });

    expect(res.status).toBe(404);
  });

  it('returns 400 for non-UUID anchor id', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/not-a-uuid/revoke')
      .send({ reason: 'Test' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
    expect(mockAnchorSingle).not.toHaveBeenCalled();
  });

  it('returns 404 for orphan anchor (org_id null)', async () => {
    mockAnchorSingle.mockResolvedValueOnce({
      data: { id: '11111111-1111-1111-1111-111111111111', status: 'SECURED', org_id: null, user_id: 'u1' },
      error: null,
    });

    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/11111111-1111-1111-1111-111111111111/revoke')
      .send({ reason: 'Test' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
    expect(mockMembershipSingle).not.toHaveBeenCalled();
  });

  it('returns 404 for anchor in another org', async () => {
    mockMembershipSingle.mockResolvedValueOnce({ data: null, error: null });

    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/11111111-1111-1111-1111-111111111111/revoke')
      .send({ reason: 'Test' });

    expect(res.status).toBe(404);
  });

  it('returns 401 without auth', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/anchor', anchorRevokeRouter);

    const res = await request(app)
      .post('/api/anchor/11111111-1111-1111-1111-111111111111/revoke')
      .send({ reason: 'Test' });

    expect(res.status).toBe(401);
  });

  it('returns 500 on RPC failure', async () => {
    mockRpc.mockResolvedValueOnce({ error: { message: 'RPC failed' } });

    const app = buildApp();
    const res = await request(app)
      .post('/api/anchor/11111111-1111-1111-1111-111111111111/revoke')
      .send({ reason: 'Test' });

    expect(res.status).toBe(500);
  });
});
