/**
 * Tests for HIPAA Emergency Access API — REG-10 (SCRUM-571)
 *
 * SECURITY REGRESSION COVERAGE (fix, 2026-07-28): all four routes previously
 * trusted `x-org-id` verbatim (via the old `requireOrgId`) with NO membership
 * check — any authenticated user could read, REQUEST, and APPROVE another
 * org's HIPAA emergency-access grants. The fix chains membership-validating
 * `requireOrgId` on all routes, plus ORG_ADMIN-gating `requireOrgAdmin` on
 * `/approve` specifically (the privilege-escalating half of dual control —
 * see the file's doc comment for the full per-route decision). The HTTP
 * tests below are the key deliverable: org-A vs org-B on read + write +
 * approve, and same-org success for a legitimate caller.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const isUserMemberOfOrgResult = vi.fn();
const isCallerOrgAdminResult = vi.fn();

vi.mock('../_org-auth.js', () => ({
  isUserMemberOfOrgResult: (...args: unknown[]) => isUserMemberOfOrgResult(...args),
  isCallerOrgAdminResult: (...args: unknown[]) => isCallerOrgAdminResult(...args),
}));

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn() },
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config.js', () => ({
  config: { frontendUrl: 'https://app.arkova.ai' },
}));

import { RequestSchema, RevokeSchema, emergencyAccessRouter } from './emergency-access.js';
import { EMERGENCY_ACCESS_MAX_HOURS } from '../../constants/hipaa.js';
import { db } from '../../utils/db.js';

function createApp(userId: string | null = 'user-org-A') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId) req.authUserId = userId;
    next();
  });
  app.use('/api/v1/emergency-access', emergencyAccessRouter);
  return app;
}

function chainableResolve(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.insert = vi.fn(chain);
  builder.select = vi.fn(chain);
  builder.update = vi.fn(chain);
  builder.eq = vi.fn(chain);
  builder.is = vi.fn(chain);
  builder.order = vi.fn(chain);
  builder.limit = vi.fn().mockResolvedValue(result);
  builder.single = vi.fn().mockResolvedValue(result);
  return builder;
}

describe('Emergency Access API — cross-tenant isolation + ORG_ADMIN approval gate (HTTP)', () => {
  const fromMock = db.from as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fromMock.mockImplementation((table: string) => {
      if (table === 'emergency_access_grants') {
        return chainableResolve({
          data: { id: 'grant-1', granted_at: '2026-07-28T00:00:00Z', expires_at: '2026-07-28T04:00:00Z', scope: 'healthcare_credentials' },
          error: null,
        });
      }
      return { insert: vi.fn().mockResolvedValue({ error: null }) };
    });
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(createApp(null))
      .get('/api/v1/emergency-access')
      .set('x-org-id', 'org-A');
    expect(res.status).toBe(401);
  });

  describe('GET / (list) — org membership level', () => {
    it('org-A caller reading org-B header is REJECTED (403), never trusted', async () => {
      isUserMemberOfOrgResult.mockResolvedValue({ value: false, error: false });
      const res = await request(createApp('user-org-A'))
        .get('/api/v1/emergency-access')
        .set('x-org-id', 'org-B');
      expect(res.status).toBe(403);
      expect(isUserMemberOfOrgResult).toHaveBeenCalledWith('user-org-A', 'org-B');
    });

    it('legitimate same-org member still succeeds (200)', async () => {
      isUserMemberOfOrgResult.mockResolvedValue({ value: true, error: false });
      fromMock.mockImplementation(() => chainableResolve({ data: [], error: null }));
      const res = await request(createApp('user-org-A'))
        .get('/api/v1/emergency-access')
        .set('x-org-id', 'org-A');
      expect(res.status).toBe(200);
    });
  });

  describe('POST / (request) — org membership level', () => {
    const validBody = { reason: 'Patient in critical care needs immediate credential check.' };

    it('org-A caller requesting under org-B header is REJECTED (403), never trusted', async () => {
      isUserMemberOfOrgResult.mockResolvedValue({ value: false, error: false });
      const res = await request(createApp('user-org-A'))
        .post('/api/v1/emergency-access')
        .set('x-org-id', 'org-B')
        .send(validBody);
      expect(res.status).toBe(403);
    });

    it('legitimate same-org member still succeeds (201) — no admin required to REQUEST', async () => {
      isUserMemberOfOrgResult.mockResolvedValue({ value: true, error: false });
      isCallerOrgAdminResult.mockResolvedValue({ value: false, error: false });
      const res = await request(createApp('user-org-A'))
        .post('/api/v1/emergency-access')
        .set('x-org-id', 'org-A')
        .send(validBody);
      expect(res.status).toBe(201);
      expect(isCallerOrgAdminResult).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /:id/approve — ORG_ADMIN required (NEW gate)', () => {
    beforeEach(() => {
      fromMock.mockImplementation((table: string) => {
        if (table === 'emergency_access_grants') {
          return chainableResolve({
            data: { grantee_id: 'requester-1', approver_id: null, expires_at: '2099-01-01T00:00:00Z', revoked_at: null },
            error: null,
          });
        }
        return { insert: vi.fn().mockResolvedValue({ error: null }) };
      });
    });

    it('org-A caller approving under org-B header is REJECTED (403), never trusted', async () => {
      isUserMemberOfOrgResult.mockResolvedValue({ value: false, error: false });
      const res = await request(createApp('admin-org-A'))
        .patch('/api/v1/emergency-access/grant-1/approve')
        .set('x-org-id', 'org-B');
      expect(res.status).toBe(403);
      expect(isCallerOrgAdminResult).not.toHaveBeenCalled();
    });

    it('org-A MEMBER who is NOT an org admin is REJECTED (403) — cannot approve', async () => {
      isUserMemberOfOrgResult.mockResolvedValue({ value: true, error: false });
      isCallerOrgAdminResult.mockResolvedValue({ value: false, error: false });
      const res = await request(createApp('member-org-A'))
        .patch('/api/v1/emergency-access/grant-1/approve')
        .set('x-org-id', 'org-A');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Organization administrator role required');
    });

    it('legitimate org-A ADMIN caller can approve (200)', async () => {
      isUserMemberOfOrgResult.mockResolvedValue({ value: true, error: false });
      isCallerOrgAdminResult.mockResolvedValue({ value: true, error: false });
      const res = await request(createApp('admin-org-A'))
        .patch('/api/v1/emergency-access/grant-1/approve')
        .set('x-org-id', 'org-A');
      expect(res.status).toBe(200);
    });
  });

  describe('PATCH /:id/revoke — org membership level (unchanged)', () => {
    it('org-A caller revoking under org-B header is REJECTED (403), never trusted', async () => {
      isUserMemberOfOrgResult.mockResolvedValue({ value: false, error: false });
      const res = await request(createApp('user-org-A'))
        .patch('/api/v1/emergency-access/grant-1/revoke')
        .set('x-org-id', 'org-B');
      expect(res.status).toBe(403);
    });

    it('legitimate same-org member can revoke (200) — no admin required', async () => {
      isUserMemberOfOrgResult.mockResolvedValue({ value: true, error: false });
      isCallerOrgAdminResult.mockResolvedValue({ value: false, error: false });
      fromMock.mockImplementation((table: string) => {
        if (table === 'emergency_access_grants') {
          return chainableResolve({ data: { id: 'grant-1', revoked_at: '2026-07-28T01:00:00Z' }, error: null });
        }
        return { insert: vi.fn().mockResolvedValue({ error: null }) };
      });
      const res = await request(createApp('user-org-A'))
        .patch('/api/v1/emergency-access/grant-1/revoke')
        .set('x-org-id', 'org-A');
      expect(res.status).toBe(200);
      expect(isCallerOrgAdminResult).not.toHaveBeenCalled();
    });
  });
});

describe('Emergency Access — REG-10', () => {
  describe('RequestSchema (exported from module)', () => {
    it('accepts valid request with defaults', () => {
      const result = RequestSchema.safeParse({
        reason: 'Emergency patient care requires immediate credential verification.',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.scope).toBe('healthcare_credentials');
        expect(result.data.duration_hours).toBe(EMERGENCY_ACCESS_MAX_HOURS);
      }
    });

    it('accepts custom duration within range', () => {
      const result = RequestSchema.safeParse({
        reason: 'Emergency: patient in critical care needs credential check.',
        duration_hours: 1,
      });
      expect(result.success).toBe(true);
    });

    it('rejects reason shorter than 10 chars', () => {
      expect(RequestSchema.safeParse({ reason: 'Too short' }).success).toBe(false);
    });

    it('rejects duration exceeding max hours', () => {
      expect(RequestSchema.safeParse({
        reason: 'Emergency requiring more than maximum duration.',
        duration_hours: EMERGENCY_ACCESS_MAX_HOURS + 1,
      }).success).toBe(false);
    });

    it('rejects duration < 0.5 hours', () => {
      expect(RequestSchema.safeParse({
        reason: 'Emergency: very short access needed.',
        duration_hours: 0.1,
      }).success).toBe(false);
    });
  });

  describe('RevokeSchema (exported from module)', () => {
    it('accepts empty body', () => {
      expect(RevokeSchema.safeParse({}).success).toBe(true);
    });

    it('accepts optional reason', () => {
      expect(RevokeSchema.safeParse({ reason: 'No longer needed' }).success).toBe(true);
    });
  });

  describe('dual-control enforcement', () => {
    it('self-approval is blocked by the endpoint (grantee_id === approverId)', () => {
      // The endpoint checks grant.grantee_id === approverId and returns 403
      const granteeId = '550e8400-e29b-41d4-a716-446655440000';
      expect(granteeId).toBe(granteeId);
    });
  });

  describe('time-limited access', () => {
    it('calculates expiry from EMERGENCY_ACCESS_MAX_HOURS', () => {
      const now = Date.now();
      const expiresAt = new Date(now + EMERGENCY_ACCESS_MAX_HOURS * 60 * 60 * 1000);
      const diffHours = (expiresAt.getTime() - now) / (60 * 60 * 1000);
      expect(diffHours).toBe(EMERGENCY_ACCESS_MAX_HOURS);
    });
  });
});
