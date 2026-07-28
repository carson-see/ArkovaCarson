/**
 * Tests for requireOrgAdmin.ts — the ORG_ADMIN-only gate layered on top of
 * requireOrgId for routes where org membership alone is too permissive
 * (HIPAA audit trail, FERPA disclosure log reads, emergency-access approval).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const isCallerOrgAdminResult = vi.fn();

vi.mock('../api/_org-auth.js', () => ({
  isCallerOrgAdminResult: (...args: unknown[]) => isCallerOrgAdminResult(...args),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { requireOrgAdmin } from './requireOrgAdmin.js';

/** Build an app that injects authUserId + orgId directly (simulating requireOrgId having already run). */
function buildApp(userId: string | undefined, orgId: string | undefined) {
  const app = express();
  app.use((req, _res, next) => {
    if (userId) req.authUserId = userId;
    if (orgId) req.orgId = orgId;
    next();
  });
  app.use(requireOrgAdmin);
  app.get('/probe', (_req, res) => res.json({ ok: true }));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requireOrgAdmin — authentication + org context', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(buildApp(undefined, 'org-A')).get('/probe');
    expect(res.status).toBe(401);
    expect(isCallerOrgAdminResult).not.toHaveBeenCalled();
  });

  it('fails closed (403) when req.orgId is not set (requireOrgId not mounted upstream)', async () => {
    const res = await request(buildApp('user-A', undefined)).get('/probe');
    expect(res.status).toBe(403);
    expect(isCallerOrgAdminResult).not.toHaveBeenCalled();
  });
});

describe('requireOrgAdmin — privilege gate', () => {
  it('returns 403 when the caller is a member but NOT an admin', async () => {
    isCallerOrgAdminResult.mockResolvedValue({ value: false, error: false });
    const res = await request(buildApp('member-A', 'org-A')).get('/probe');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Organization administrator role required');
  });

  it('allows an org admin through', async () => {
    isCallerOrgAdminResult.mockResolvedValue({ value: true, error: false });
    const res = await request(buildApp('admin-A', 'org-A')).get('/probe');
    expect(res.status).toBe(200);
    expect(isCallerOrgAdminResult).toHaveBeenCalledWith('admin-A', 'org-A');
  });

  it('returns 500 (not a masked 403) on a DB/operational error', async () => {
    isCallerOrgAdminResult.mockResolvedValue({ value: false, error: true });
    const res = await request(buildApp('admin-A', 'org-A')).get('/probe');
    expect(res.status).toBe(500);
  });
});
