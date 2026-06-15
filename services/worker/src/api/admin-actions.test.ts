/**
 * Unit tests for Admin Actions API — handleSetOrgQuota (SCRUM-2225)
 *
 * Free-tier action cap: a platform admin sets an org's testing allowance
 * (org_credits.is_test + anchor_quota). Tests cover the admin gate, input
 * validation, RPC dispatch shape, and error mapping.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks ----
const { mockIsPlatformAdmin, mockRpc, mockLogger } = vi.hoisted(() => ({
  mockIsPlatformAdmin: vi.fn(),
  mockRpc: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/platformAdmin.js', () => ({ isPlatformAdmin: mockIsPlatformAdmin }));
vi.mock('../utils/db.js', () => ({ db: { rpc: mockRpc } }));
vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));

import { handleSetOrgQuota } from './admin-actions.js';
import type { Request, Response } from 'express';

function mockReq(body: Record<string, unknown> = {}): Request {
  return { body } as unknown as Request;
}

function mockRes(): Response & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.body = data;
      return res;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

const ADMIN = 'admin-user-id';
const ORG = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  mockIsPlatformAdmin.mockResolvedValue(true);
  mockRpc.mockResolvedValue({ data: { org_id: ORG, is_test: true, anchor_quota: 10 }, error: null });
});

describe('handleSetOrgQuota (SCRUM-2225)', () => {
  it('rejects a non-platform-admin with 403 and never touches the DB', async () => {
    mockIsPlatformAdmin.mockResolvedValue(false);
    const res = mockRes();
    await handleSetOrgQuota(ADMIN, ORG, mockReq({ anchor_quota: 10 }), res);
    expect(res.statusCode).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('rejects a negative anchor_quota with 400', async () => {
    const res = mockRes();
    await handleSetOrgQuota(ADMIN, ORG, mockReq({ anchor_quota: -1 }), res);
    expect(res.statusCode).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('rejects a non-integer anchor_quota with 400', async () => {
    const res = mockRes();
    await handleSetOrgQuota(ADMIN, ORG, mockReq({ anchor_quota: 3.5 }), res);
    expect(res.statusCode).toBe(400);
  });

  it('rejects a non-boolean is_test with 400', async () => {
    const res = mockRes();
    await handleSetOrgQuota(ADMIN, ORG, mockReq({ anchor_quota: 10, is_test: 'yes' }), res);
    expect(res.statusCode).toBe(400);
  });

  it('sets the cap with default is_test=true and dispatches the RPC with the actor', async () => {
    const res = mockRes();
    await handleSetOrgQuota(ADMIN, ORG, mockReq({ anchor_quota: 10 }), res);
    expect(res.statusCode).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('admin_set_org_anchor_quota', {
      p_org_id: ORG,
      p_anchor_quota: 10,
      p_is_test: true,
      p_actor: ADMIN,
    });
    expect((res.body as { success: boolean }).success).toBe(true);
  });

  it('allows null anchor_quota (uncapped) with is_test=false to convert an org to billable', async () => {
    const res = mockRes();
    await handleSetOrgQuota(ADMIN, ORG, mockReq({ anchor_quota: null, is_test: false }), res);
    expect(res.statusCode).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('admin_set_org_anchor_quota', {
      p_org_id: ORG,
      p_anchor_quota: null,
      p_is_test: false,
      p_actor: ADMIN,
    });
  });

  it('maps an RPC failure to 500', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const res = mockRes();
    await handleSetOrgQuota(ADMIN, ORG, mockReq({ anchor_quota: 10 }), res);
    expect(res.statusCode).toBe(500);
  });
});
