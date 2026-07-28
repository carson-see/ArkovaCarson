/**
 * Tests for the cross-tenant authorization fix in requireOrgId.ts.
 *
 * SECURITY REGRESSION COVERAGE: this middleware previously trusted
 * `x-org-id` verbatim off the request with NO check that the authenticated
 * caller belonged to that org — a full cross-tenant authorization bypass on
 * every route mounted behind it. These tests are the red-first proof of the
 * fix: an authenticated user from org A must be REJECTED (403) when
 * requesting org B via the header, and a legitimate same-org caller must
 * still succeed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const isUserMemberOfOrgResult = vi.fn();

vi.mock('../api/_org-auth.js', () => ({
  isUserMemberOfOrgResult: (...args: unknown[]) => isUserMemberOfOrgResult(...args),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { requireOrgId } from './requireOrgId.js';

/** Build a minimal app that injects a fixed authUserId and mounts the middleware. */
function buildApp(userId: string | undefined, authField: 'authUserId' | 'userId' = 'authUserId') {
  const app = express();
  app.use((req, _res, next) => {
    if (userId) (req as unknown as Record<string, string>)[authField] = userId;
    next();
  });
  app.use(requireOrgId);
  app.get('/probe', (req, res) => {
    res.json({ orgId: req.orgId });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requireOrgId — authentication', () => {
  it('returns 401 when unauthenticated (no authUserId/userId set)', async () => {
    const res = await request(buildApp(undefined)).get('/probe').set('x-org-id', 'org-A');
    expect(res.status).toBe(401);
    expect(isUserMemberOfOrgResult).not.toHaveBeenCalled();
  });
});

describe('requireOrgId — header presence', () => {
  it('returns 400 when x-org-id header is missing', async () => {
    const res = await request(buildApp('user-A')).get('/probe');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('x-org-id header required');
    expect(isUserMemberOfOrgResult).not.toHaveBeenCalled();
  });
});

// ─── THE KEY DELIVERABLE: cross-tenant isolation ────────────────────────────
describe('requireOrgId — cross-tenant isolation (org A vs org B)', () => {
  it('rejects a user from org A requesting org B via x-org-id (403)', async () => {
    // user-A is authenticated but is NOT a member of org-B.
    isUserMemberOfOrgResult.mockResolvedValue({ value: false, error: false });

    const res = await request(buildApp('user-A')).get('/probe').set('x-org-id', 'org-B');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Not authorized for this organization');
    expect(isUserMemberOfOrgResult).toHaveBeenCalledWith('user-A', 'org-B');
  });

  it('allows a legitimate same-org caller through (200, req.orgId set)', async () => {
    // user-A IS a member of org-A.
    isUserMemberOfOrgResult.mockResolvedValue({ value: true, error: false });

    const res = await request(buildApp('user-A')).get('/probe').set('x-org-id', 'org-A');

    expect(res.status).toBe(200);
    expect(res.body.orgId).toBe('org-A');
    expect(isUserMemberOfOrgResult).toHaveBeenCalledWith('user-A', 'org-A');
  });

  it('never trusts the header as identity — an attacker cannot forge membership by supplying any org id', async () => {
    // Simulate an attacker (user-EVIL, authenticated, belongs to no orgs)
    // trying every plausible org id — every single one must be checked
    // against real membership and rejected.
    isUserMemberOfOrgResult.mockResolvedValue({ value: false, error: false });

    for (const forgedOrgId of ['org-victim-1', 'org-victim-2', "' OR '1'='1", 'admin', '../../etc']) {
      const res = await request(buildApp('user-EVIL')).get('/probe').set('x-org-id', forgedOrgId);
      expect(res.status).toBe(403);
    }
  });

  it('supports req.userId (routes/middleware.ts requireAuth convention) as well as req.authUserId', async () => {
    isUserMemberOfOrgResult.mockResolvedValue({ value: true, error: false });
    const res = await request(buildApp('user-A', 'userId')).get('/probe').set('x-org-id', 'org-A');
    expect(res.status).toBe(200);
    expect(isUserMemberOfOrgResult).toHaveBeenCalledWith('user-A', 'org-A');
  });
});

describe('requireOrgId — DB/operational errors return 500, not a masked 403', () => {
  it('returns 500 when the membership lookup hits a DB error', async () => {
    isUserMemberOfOrgResult.mockResolvedValue({ value: false, error: true });
    const res = await request(buildApp('user-A')).get('/probe').set('x-org-id', 'org-A');
    expect(res.status).toBe(500);
  });
});
