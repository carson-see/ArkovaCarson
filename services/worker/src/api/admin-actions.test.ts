/**
 * Unit tests for Admin Actions API — handleSetOrgQuota (SCRUM-2225)
 *
 * Document cap: a platform admin sets an org's allowance
 * (org_credits.anchor_quota + cap_enforced). Tests cover the admin gate, input
 * validation, RPC dispatch shape, and error mapping.
 *
 * SCRUM-3882 decoupled the cap from `is_test`. Two contract changes are pinned
 * below: the RPC is now admin_set_org_cap, and omitting `is_test` PRESERVES the
 * org's current billing flag instead of forcing it to true. The old default
 * silently converted any org you capped into a Stripe-excluded test org.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks ----
const { mockIsPlatformAdmin, mockRpc, mockFrom, mockLogger } = vi.hoisted(() => ({
  mockIsPlatformAdmin: vi.fn(),
  mockRpc: vi.fn(),
  mockFrom: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/platformAdmin.js', () => ({ isPlatformAdmin: mockIsPlatformAdmin }));
vi.mock('../utils/db.js', () => ({ db: { rpc: mockRpc, from: mockFrom } }));
vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));

import { handleSetOrgQuota, handleAdjustOrgCredit } from './admin-actions.js';
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
  mockRpc.mockResolvedValue({ data: { org_id: ORG, is_test: true, anchor_quota: 10, cap_enforced: true }, error: null });
  // Current billing flag, read only when the caller omits is_test.
  setCurrentIsTest(false);
});

/** Stub `db.from('org_credits').select('is_test').eq(...).maybeSingle()`. */
function setCurrentIsTest(isTest: boolean | null, error: { message: string } | null = null) {
  mockFrom.mockImplementation(() => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: isTest === null ? null : { is_test: isTest }, error }),
      }),
    }),
  }));
}

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

  it('sets the cap, enforces it by default, and dispatches the RPC with the actor', async () => {
    const res = mockRes();
    await handleSetOrgQuota(ADMIN, ORG, mockReq({ anchor_quota: 10 }), res);
    expect(res.statusCode).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('admin_set_org_cap', {
      p_org_id: ORG,
      p_anchor_quota: 10,
      p_cap_enforced: true,
      p_is_test: false,
      p_actor: ADMIN,
    });
    expect((res.body as { success: boolean }).success).toBe(true);
  });

  it('PRESERVES the current billing flag when is_test is omitted (SCRUM-3882)', async () => {
    // The bug this replaced: is_test defaulted to true, so capping a billable
    // customer silently excluded it from Stripe metered billing.
    setCurrentIsTest(false);
    const res = mockRes();
    await handleSetOrgQuota(ADMIN, ORG, mockReq({ anchor_quota: 2000 }), res);
    expect(mockRpc).toHaveBeenCalledWith(
      'admin_set_org_cap',
      expect.objectContaining({ p_is_test: false, p_cap_enforced: true, p_anchor_quota: 2000 }),
    );
  });

  it('preserves a TEST org\'s flag too when is_test is omitted', async () => {
    setCurrentIsTest(true);
    const res = mockRes();
    await handleSetOrgQuota(ADMIN, ORG, mockReq({ anchor_quota: 10 }), res);
    expect(mockRpc).toHaveBeenCalledWith(
      'admin_set_org_cap',
      expect.objectContaining({ p_is_test: true }),
    );
  });

  it('503s without touching the RPC when the current billing flag cannot be read', async () => {
    // Guessing here is how an org silently changes billing state.
    setCurrentIsTest(null, { message: 'connection reset' });
    const res = mockRes();
    await handleSetOrgQuota(ADMIN, ORG, mockReq({ anchor_quota: 10 }), res);
    expect(res.statusCode).toBe(503);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('honours an explicit cap_enforced=false — a recorded but inert cap', async () => {
    const res = mockRes();
    await handleSetOrgQuota(ADMIN, ORG, mockReq({ anchor_quota: 15, cap_enforced: false }), res);
    expect(mockRpc).toHaveBeenCalledWith(
      'admin_set_org_cap',
      expect.objectContaining({ p_anchor_quota: 15, p_cap_enforced: false }),
    );
  });

  it('rejects cap_enforced=true with a null quota (a cap with no number is a no-op)', async () => {
    const res = mockRes();
    await handleSetOrgQuota(ADMIN, ORG, mockReq({ anchor_quota: null, cap_enforced: true }), res);
    expect(res.statusCode).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean cap_enforced with 400', async () => {
    const res = mockRes();
    await handleSetOrgQuota(ADMIN, ORG, mockReq({ anchor_quota: 10, cap_enforced: 'yes' }), res);
    expect(res.statusCode).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('allows null anchor_quota (uncapped) with is_test=false to convert an org to billable', async () => {
    const res = mockRes();
    await handleSetOrgQuota(ADMIN, ORG, mockReq({ anchor_quota: null, is_test: false }), res);
    expect(res.statusCode).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('admin_set_org_cap', {
      p_org_id: ORG,
      p_anchor_quota: null,
      p_cap_enforced: false,
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

/**
 * Unit tests for handleAdjustOrgCredit (L2-A5, founder admin-controls)
 *
 * Platform-admin add/remove on org_credits.balance via the
 * admin_adjust_org_credit RPC (migration 0375). Covers the admin gate,
 * input validation, RPC dispatch shape, idempotent-retry passthrough, and
 * error-code -> HTTP-status mapping.
 */
describe('handleAdjustOrgCredit (L2-A5)', () => {
  const IDEMPOTENCY_KEY = 'aaaaaaaa-0000-4000-8000-000000000001';

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPlatformAdmin.mockResolvedValue(true);
    mockRpc.mockResolvedValue({
      data: { success: true, balance: 150, adjusted: 50, entry_type: 'GRANT', idempotent: false },
      error: null,
    });
  });

  it('rejects a non-platform-admin with 403 and never touches the DB', async () => {
    mockIsPlatformAdmin.mockResolvedValue(false);
    const res = mockRes();
    await handleAdjustOrgCredit(ADMIN, ORG, mockReq({ amount: 50, reason: 'promo', idempotency_key: IDEMPOTENCY_KEY }), res);
    expect(res.statusCode).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  // SonarCloud typescript:S5976 — these were 6 near-identical tests differing
  // only by the invalid request body; consolidated into one parameterized
  // case so each new invalid-input case is a one-line addition, not a
  // copy-pasted test body.
  it.each<{ name: string; body: Record<string, unknown> }>([
    { name: 'amount = 0', body: { amount: 0, reason: 'promo', idempotency_key: IDEMPOTENCY_KEY } },
    { name: 'a non-integer amount', body: { amount: 3.5, reason: 'promo', idempotency_key: IDEMPOTENCY_KEY } },
    { name: 'a missing reason', body: { amount: 50, idempotency_key: IDEMPOTENCY_KEY } },
    { name: 'a blank (whitespace-only) reason', body: { amount: 50, reason: '   ', idempotency_key: IDEMPOTENCY_KEY } },
    { name: 'a missing idempotency_key', body: { amount: 50, reason: 'promo' } },
    { name: 'a malformed (non-UUID) idempotency_key', body: { amount: 50, reason: 'promo', idempotency_key: 'not-a-uuid' } },
  ])('rejects $name with 400 and never touches the DB', async ({ body }) => {
    const res = mockRes();
    await handleAdjustOrgCredit(ADMIN, ORG, mockReq(body), res);
    expect(res.statusCode).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('dispatches a GRANT (positive amount) to the RPC with the actor and returns 200', async () => {
    const res = mockRes();
    await handleAdjustOrgCredit(ADMIN, ORG, mockReq({ amount: 50, reason: 'promo credit', idempotency_key: IDEMPOTENCY_KEY }), res);
    expect(mockRpc).toHaveBeenCalledWith('admin_adjust_org_credit', {
      p_org_id: ORG,
      p_amount: 50,
      p_reason: 'promo credit',
      p_idempotency_key: IDEMPOTENCY_KEY,
      p_actor: ADMIN,
    });
    expect(res.statusCode).toBe(200);
    const body = res.body as { success: boolean; balance: number; adjusted: number; entry_type: string };
    expect(body.success).toBe(true);
    expect(body.balance).toBe(150);
    expect(body.adjusted).toBe(50);
    expect(body.entry_type).toBe('GRANT');
  });

  it('dispatches a REVOKE (negative amount) to the RPC unchanged (sign preserved)', async () => {
    mockRpc.mockResolvedValue({
      data: { success: true, balance: 70, adjusted: -30, entry_type: 'REVOKE', idempotent: false },
      error: null,
    });
    const res = mockRes();
    await handleAdjustOrgCredit(ADMIN, ORG, mockReq({ amount: -30, reason: 'clawback: mistaken grant', idempotency_key: IDEMPOTENCY_KEY }), res);
    expect(mockRpc).toHaveBeenCalledWith('admin_adjust_org_credit', expect.objectContaining({ p_amount: -30 }));
    expect(res.statusCode).toBe(200);
    expect((res.body as { entry_type: string }).entry_type).toBe('REVOKE');
  });

  it('an idempotent-replay RPC result (retry) surfaces idempotent: true, not a duplicate charge', async () => {
    mockRpc.mockResolvedValue({
      data: { success: true, balance: 150, adjusted: 0, entry_type: 'GRANT', idempotent: true },
      error: null,
    });
    const res = mockRes();
    await handleAdjustOrgCredit(ADMIN, ORG, mockReq({ amount: 50, reason: 'promo credit', idempotency_key: IDEMPOTENCY_KEY }), res);
    expect(res.statusCode).toBe(200);
    const body = res.body as { idempotent: boolean; adjusted: number };
    expect(body.idempotent).toBe(true);
    expect(body.adjusted).toBe(0);
  });

  it('maps a REVOKE beyond balance (insufficient_balance) to 409, balance unchanged', async () => {
    mockRpc.mockResolvedValue({
      data: { success: false, error: 'insufficient_balance', balance: 20, requested: -500 },
      error: null,
    });
    const res = mockRes();
    await handleAdjustOrgCredit(ADMIN, ORG, mockReq({ amount: -500, reason: 'oops', idempotency_key: IDEMPOTENCY_KEY }), res);
    expect(res.statusCode).toBe(409);
    const body = res.body as { error: string; balance: number };
    expect(body.error).toBe('insufficient_balance');
    expect(body.balance).toBe(20);
  });

  it('maps an idempotency_key_conflict (same key, different amount/reason) to 409', async () => {
    mockRpc.mockResolvedValue({
      data: { success: false, error: 'idempotency_key_conflict' },
      error: null,
    });
    const res = mockRes();
    await handleAdjustOrgCredit(ADMIN, ORG, mockReq({ amount: 999, reason: 'promo credit', idempotency_key: IDEMPOTENCY_KEY }), res);
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toBe('idempotency_key_conflict');
  });

  it('maps org_not_initialized to 404', async () => {
    mockRpc.mockResolvedValue({ data: { success: false, error: 'org_not_initialized' }, error: null });
    const res = mockRes();
    await handleAdjustOrgCredit(ADMIN, ORG, mockReq({ amount: 50, reason: 'promo', idempotency_key: IDEMPOTENCY_KEY }), res);
    expect(res.statusCode).toBe(404);
  });

  it('maps a transport/RPC error to 500', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const res = mockRes();
    await handleAdjustOrgCredit(ADMIN, ORG, mockReq({ amount: 50, reason: 'promo', idempotency_key: IDEMPOTENCY_KEY }), res);
    expect(res.statusCode).toBe(500);
  });
});
