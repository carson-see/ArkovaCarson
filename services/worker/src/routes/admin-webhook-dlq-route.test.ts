/**
 * Inbound webhook DLQ route round-trip: authz envelope (SCRUM-4514).
 *
 * `admin-webhook-dlq.test.ts` pins the handlers directly. This suite closes
 * the router-level authz gap: a real Express round-trip through the same
 * `extractAuthUserId` -> `isPlatformAdmin` envelope every other adminRouter
 * route uses (mirrors `admin-ops-slo-route.test.ts`'s pattern), proving:
 *
 *   - An API-key-only / unauthenticated request (no session Bearer token,
 *     so `extractAuthUserId` resolves null) gets 401, never reaching the
 *     handler or the DB.
 *   - An authenticated session belonging to a non-platform-admin (e.g. an
 *     org admin) gets 403 from inside the handler.
 *   - A platform-admin session gets a real 200 round-trip.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { extractAuthUserIdMock, isPlatformAdminMock, mockFrom } = vi.hoisted(() => ({
  extractAuthUserIdMock: vi.fn(),
  isPlatformAdminMock: vi.fn(),
  mockFrom: vi.fn(),
}));

vi.mock('../utils/db.js', () => ({ db: { from: mockFrom } }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/platformAdmin.js', () => ({ isPlatformAdmin: isPlatformAdminMock }));

import express from 'express';
import request from 'supertest';
import { handleWebhookDlqList, handleWebhookDlqResolve } from '../api/admin-webhook-dlq.js';

/**
 * Mounts the two routes with the EXACT production wiring from
 * `routes/admin.ts`: `extractAuthUserId` -> 401 guard, then delegate to the
 * handler inside a try/catch -> 500. `extractAuthUserId` is injected via the
 * hoisted mock so this exercises the auth envelope without loading
 * `config.ts`/`auth.js` (which the full adminRouter would drag in).
 */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.get('/api/admin/webhook-dlq', async (req: Request, res: Response) => {
    const userId = await extractAuthUserIdMock(req);
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    try {
      await handleWebhookDlqList(userId, req, res);
    } catch {
      res.status(500).json({ error: 'Internal server error' });
    }
  });
  app.post('/api/admin/webhook-dlq/resolve', async (req: Request, res: Response) => {
    const userId = await extractAuthUserIdMock(req);
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    try {
      await handleWebhookDlqResolve(userId, req, res);
    } catch {
      res.status(500).json({ error: 'Internal server error' });
    }
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SCRUM-4514: GET/POST /api/admin/webhook-dlq* authz envelope', () => {
  it('GET: no session (e.g. API-key-only request, no Bearer token) -> 401, DB never touched', async () => {
    extractAuthUserIdMock.mockResolvedValue(null);
    const app = buildApp();
    const res = await request(app).get('/api/admin/webhook-dlq');
    expect(res.status).toBe(401);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(isPlatformAdminMock).not.toHaveBeenCalled();
  });

  it('POST resolve: no session -> 401, DB never touched', async () => {
    extractAuthUserIdMock.mockResolvedValue(null);
    const app = buildApp();
    const res = await request(app)
      .post('/api/admin/webhook-dlq/resolve')
      .send({ ids: ['r1'], note: 'resent at partner' });
    expect(res.status).toBe(401);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(isPlatformAdminMock).not.toHaveBeenCalled();
  });

  it('GET: authenticated session, but not a platform admin (e.g. org admin) -> 403', async () => {
    extractAuthUserIdMock.mockResolvedValue('org-admin-user-id');
    isPlatformAdminMock.mockResolvedValue(false);
    const app = buildApp();
    const res = await request(app).get('/api/admin/webhook-dlq');
    expect(res.status).toBe(403);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('POST resolve: authenticated session, but not a platform admin -> 403', async () => {
    extractAuthUserIdMock.mockResolvedValue('org-admin-user-id');
    isPlatformAdminMock.mockResolvedValue(false);
    const app = buildApp();
    const res = await request(app)
      .post('/api/admin/webhook-dlq/resolve')
      .send({ ids: ['r1'], note: 'resent at partner' });
    expect(res.status).toBe(403);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('GET: platform admin -> real 200 round-trip with JSON body', async () => {
    extractAuthUserIdMock.mockResolvedValue('platform-admin-id');
    isPlatformAdminMock.mockResolvedValue(true);
    mockFrom.mockReturnValue({
      select: () => ({ is: () => ({ order: () => ({ data: [], error: null }) }) }),
    });
    const app = buildApp();
    const res = await request(app).get('/api/admin/webhook-dlq');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total_unresolved: 0, by_provider: {}, rows: [] });
  });

  it('POST resolve: platform admin -> real 200 round-trip resolving a row', async () => {
    const rowId = '11111111-1111-1111-1111-111111111111'; // webhook_dlq.id is uuid
    extractAuthUserIdMock.mockResolvedValue('platform-admin-id');
    isPlatformAdminMock.mockResolvedValue(true);
    mockFrom.mockImplementation(() => ({
      update: () => ({
        in: () => ({
          is: () => ({ select: () => ({ data: [{ id: rowId }], error: null }) }),
        }),
      }),
      select: () => ({ in: () => ({ not: () => ({ data: [], error: null }) }) }),
    }));
    const app = buildApp();
    const res = await request(app)
      .post('/api/admin/webhook-dlq/resolve')
      .send({ ids: [rowId], note: 'resent via DocuSign Connect logs' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ resolved: 1, already_resolved: 0 });
  });
});
