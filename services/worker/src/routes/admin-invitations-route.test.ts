import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const { mockExtractAuthUserId, mockIsPlatformAdmin, mockHandleInvitation, mockHandleListInvitations } = vi.hoisted(() => ({
  mockExtractAuthUserId: vi.fn(),
  mockIsPlatformAdmin: vi.fn(),
  mockHandleInvitation: vi.fn(),
  mockHandleListInvitations: vi.fn(),
}));

vi.mock('./middleware.js', () => ({
  corsMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  extractAuthUserId: mockExtractAuthUserId,
}));
vi.mock('../utils/rateLimit.js', () => {
  const passthrough = (_req: Request, _res: Response, next: NextFunction) => next();
  return { rateLimiters: { checkout: passthrough } };
});
vi.mock('../utils/platformAdmin.js', () => ({ isPlatformAdmin: mockIsPlatformAdmin }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/db.js', () => ({
  db: { from: vi.fn(), rpc: vi.fn() },
  getQueryStats: vi.fn(() => ({})),
  getConnectionInfo: vi.fn(() => ({})),
}));
vi.mock('../config.js', () => ({ config: { frontendUrl: 'https://app.arkova.test' } }));
vi.mock('../api/admin-invitations.js', () => ({
  handleAdminCreateInvitation: mockHandleInvitation,
  handleAdminListInvitations: mockHandleListInvitations,
}));

import express from 'express';
import request from 'supertest';
import { adminRouter } from './admin.js';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api', adminRouter);
  return instance;
}

describe('POST /api/admin/organizations/:id/invitations route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExtractAuthUserId.mockResolvedValue('admin-user');
    mockIsPlatformAdmin.mockResolvedValue(true);
    mockHandleInvitation.mockImplementation(async (_userId, _orgId, _req, res: Response) => {
      res.status(201).json({ sent: true });
    });
  });

  it('is mounted and forwards the authenticated actor plus selected org id', async () => {
    const res = await request(app())
      .post(`/api/admin/organizations/${ORG_ID}/invitations`)
      .send({ email: 'synthetic@example.test' });

    expect(res.status).toBe(201);
    expect(mockHandleInvitation).toHaveBeenCalledWith(
      'admin-user',
      ORG_ID,
      expect.objectContaining({ body: { email: 'synthetic@example.test' } }),
      expect.anything(),
    );
  });

  it('is blocked by the structural platform-admin gate before the handler', async () => {
    mockIsPlatformAdmin.mockResolvedValue(false);
    const res = await request(app())
      .post(`/api/admin/organizations/${ORG_ID}/invitations`)
      .send({ email: 'synthetic@example.test' });

    expect(res.status).toBe(403);
    expect(mockHandleInvitation).not.toHaveBeenCalled();
  });
});


describe('GET /api/admin/organizations/:id/invitations route', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mockExtractAuthUserId.mockResolvedValue('admin-user'); mockIsPlatformAdmin.mockResolvedValue(true);
    mockHandleListInvitations.mockImplementation(async (_actor, _org, _req, res: Response) => res.json({ invitations: [] }));
  });
  it('forwards the verified actor and selected organization to the list handler', async () => {
    const res = await request(app()).get(`/api/admin/organizations/${ORG_ID}/invitations`);
    expect(res.status).toBe(200); expect(res.body).toEqual({ invitations: [] });
    expect(mockHandleListInvitations).toHaveBeenCalledWith('admin-user', ORG_ID, expect.anything(), expect.anything());
  });
  it('rejects missing authentication before the handler', async () => {
    mockExtractAuthUserId.mockResolvedValue(null);
    const res = await request(app()).get(`/api/admin/organizations/${ORG_ID}/invitations`);
    expect(res.status).toBe(401); expect(mockHandleListInvitations).not.toHaveBeenCalled();
  });
  it('rejects authenticated non-platform admins before the handler', async () => {
    mockIsPlatformAdmin.mockResolvedValue(false);
    const res = await request(app()).get(`/api/admin/organizations/${ORG_ID}/invitations`);
    expect(res.status).toBe(403); expect(mockHandleListInvitations).not.toHaveBeenCalled();
  });
});
