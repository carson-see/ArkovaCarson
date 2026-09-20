import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  userId: '11111111-1111-4111-8111-111111111111' as string | null,
  profile: { org_id: null as string | null, role: 'USER', is_platform_admin: false },
  admin: false,
  member: false,
  checkout: vi.fn(),
}));
vi.mock('./middleware.js', () => ({
  corsMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  extractAuthUserId: vi.fn(async () => state.userId),
}));
vi.mock('../api/_org-auth.js', () => ({
  getCallerProfileResult: vi.fn(async () => ({ value: state.profile, error: false })),
  isCallerOrgAdminResult: vi.fn(async () => ({ value: state.admin, error: false })),
  isUserMemberOfOrgResult: vi.fn(async () => ({ value: state.member, error: false })),
}));
vi.mock('../stripe/client.js', () => ({
  createAnchorCreditCheckoutSession: state.checkout,
}));
vi.mock('../config.js', () => ({ config: { enableInstantSecure: true } }));
vi.mock('../utils/db.js', () => ({ db: { from: vi.fn() } }));
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../utils/rateLimit.js', () => ({ rateLimiters: { checkout: (_req: unknown, _res: unknown, next: () => void) => next() } }));

import { anchorCreditPurchaseRouter } from './anchor-credit-purchase.js';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/v1/anchor-credits', anchorCreditPurchaseRouter);
  return instance;
}

describe('anchor credit purchase checkout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.userId = '11111111-1111-4111-8111-111111111111';
    state.profile = { org_id: null, role: 'USER', is_platform_admin: false };
    state.admin = false;
    state.member = false;
    state.checkout.mockResolvedValue({ sessionId: 'cs_1', url: 'https://checkout.stripe.test/1' });
  });

  it('creates a personal $2-per-credit one-time checkout scoped to the caller', async () => {
    const response = await request(app()).post('/api/v1/anchor-credits/purchase').send({ quantity: 3 });
    expect(response.status).toBe(200);
    expect(state.checkout).toHaveBeenCalledWith(expect.objectContaining({
      purchaserUserId: state.userId,
      targetUserId: state.userId,
      targetOrgId: null,
      quantity: 3,
    }));
  });

  it('lets an org admin purchase only for their exact current org', async () => {
    state.profile = { org_id: '22222222-2222-4222-8222-222222222222', role: 'ORG_ADMIN', is_platform_admin: false };
    state.admin = true;
    const attackerChoice = await request(app()).post('/api/v1/anchor-credits/purchase').send({ quantity: 7, orgId: 'attacker-choice' });
    expect(attackerChoice.status).toBe(400);
    const response = await request(app()).post('/api/v1/anchor-credits/purchase').send({ quantity: 7 });
    expect(response.status).toBe(200);
    expect(state.checkout).toHaveBeenCalledWith(expect.objectContaining({
      targetUserId: null,
      targetOrgId: state.profile.org_id,
      quantity: 7,
    }));
  });

  it('guides an org member to their administrator without creating checkout', async () => {
    state.profile = { org_id: '22222222-2222-4222-8222-222222222222', role: 'MEMBER', is_platform_admin: false };
    const response = await request(app()).post('/api/v1/anchor-credits/purchase').send({ quantity: 1 });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('organization_admin_required');
    expect(state.checkout).not.toHaveBeenCalled();
  });

  it('lets a child-org admin buy into the selected child pool without changing the parent', async () => {
    const parentId = '22222222-2222-4222-8222-222222222222';
    const childId = '33333333-3333-4333-8333-333333333333';
    state.profile = { org_id: parentId, role: 'ORG_ADMIN', is_platform_admin: false };
    state.member = true;
    state.admin = true;

    const response = await request(app()).post('/api/v1/anchor-credits/purchase').send({ quantity: 4, org_id: childId });
    expect(response.status).toBe(200);
    expect(state.checkout).toHaveBeenCalledWith(expect.objectContaining({
      targetUserId: null,
      targetOrgId: childId,
      quantity: 4,
    }));
  });

  it('rejects invalid purchase quantities', async () => {
    const response = await request(app()).post('/api/v1/anchor-credits/purchase').send({ quantity: 1001 });
    expect(response.status).toBe(400);
    expect(state.checkout).not.toHaveBeenCalled();
  });
});
