/**
 * Tests for HIPAA Audit Report API — REG-07 (SCRUM-566)
 *
 * SECURITY REGRESSION COVERAGE (fix, 2026-07-28): both routes previously
 * trusted `x-org-id` verbatim (via the old `requireOrgId`) with NO membership
 * check — any authenticated user could read another org's HIPAA audit trail.
 * The fix chains membership-validating `requireOrgId` + ORG_ADMIN-gating
 * `requireOrgAdmin` (reading a HIPAA audit trail is admin-only per the
 * least-privilege decision documented in hipaa-audit.ts). The HTTP tests
 * below prove: (a) an org-A caller targeting org-B is rejected, (b) an org-A
 * MEMBER who is not an admin is rejected, (c) a legitimate org-A ADMIN
 * succeeds.
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

import { HIPAA_HEALTHCARE_TYPES } from '../../constants/hipaa.js';
import { AuditQuerySchema, hipaaAuditRouter } from './hipaa-audit.js';
import { db } from '../../utils/db.js';

function createApp(userId: string | null = 'user-org-A') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId) req.authUserId = userId;
    next();
  });
  app.use('/api/v1/hipaa/audit', hipaaAuditRouter);
  return app;
}

function chainableResolve(result: { data: unknown; error: unknown; count?: number }) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.select = vi.fn(chain);
  builder.eq = vi.fn(chain);
  builder.order = vi.fn(chain);
  builder.gte = vi.fn(chain);
  builder.lte = vi.fn(chain);
  builder.limit = vi.fn().mockResolvedValue(result);
  return builder;
}

describe('HIPAA Audit Report API — cross-tenant + ORG_ADMIN gate (HTTP)', () => {
  const fromMock = db.from as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fromMock.mockImplementation(() => chainableResolve({ data: [], error: null }));
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(createApp(null)).get('/api/v1/hipaa/audit').set('x-org-id', 'org-A');
    expect(res.status).toBe(401);
  });

  it('returns 400 when x-org-id header is missing', async () => {
    isUserMemberOfOrgResult.mockResolvedValue({ value: true, error: false });
    isCallerOrgAdminResult.mockResolvedValue({ value: true, error: false });
    const res = await request(createApp('user-org-A')).get('/api/v1/hipaa/audit');
    expect(res.status).toBe(400);
  });

  // ─── Cross-tenant isolation (KEY DELIVERABLE) ────────────────────────
  it('org-A caller reading org-B header is REJECTED (403), never trusted', async () => {
    isUserMemberOfOrgResult.mockResolvedValue({ value: false, error: false });
    const res = await request(createApp('user-org-A'))
      .get('/api/v1/hipaa/audit')
      .set('x-org-id', 'org-B');
    expect(res.status).toBe(403);
    expect(isUserMemberOfOrgResult).toHaveBeenCalledWith('user-org-A', 'org-B');
    expect(isCallerOrgAdminResult).not.toHaveBeenCalled();
  });

  it('org-A MEMBER who is not an org admin is REJECTED (403)', async () => {
    isUserMemberOfOrgResult.mockResolvedValue({ value: true, error: false });
    isCallerOrgAdminResult.mockResolvedValue({ value: false, error: false });
    const res = await request(createApp('member-org-A'))
      .get('/api/v1/hipaa/audit')
      .set('x-org-id', 'org-A');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Organization administrator role required');
  });

  it('legitimate org-A ADMIN caller still succeeds (200)', async () => {
    isUserMemberOfOrgResult.mockResolvedValue({ value: true, error: false });
    isCallerOrgAdminResult.mockResolvedValue({ value: true, error: false });
    const res = await request(createApp('admin-org-A'))
      .get('/api/v1/hipaa/audit')
      .set('x-org-id', 'org-A');
    expect(res.status).toBe(200);
  });

  it('export route: org-A admin exporting org-B header is REJECTED (403), never trusted', async () => {
    isUserMemberOfOrgResult.mockResolvedValue({ value: false, error: false });
    const res = await request(createApp('admin-org-A'))
      .get('/api/v1/hipaa/audit/export')
      .set('x-org-id', 'org-B');
    expect(res.status).toBe(403);
  });

  it('export route: legitimate org-A ADMIN caller still succeeds (200, CSV)', async () => {
    isUserMemberOfOrgResult.mockResolvedValue({ value: true, error: false });
    isCallerOrgAdminResult.mockResolvedValue({ value: true, error: false });
    const res = await request(createApp('admin-org-A'))
      .get('/api/v1/hipaa/audit/export')
      .set('x-org-id', 'org-A');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
  });
});

describe('HIPAA Audit Report — REG-07', () => {
  describe('AuditQuerySchema (exported from module)', () => {
    it('accepts empty query with defaults', () => {
      const result = AuditQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(1);
        expect(result.data.limit).toBe(50);
      }
    });

    it('coerces string page/limit', () => {
      const result = AuditQuerySchema.safeParse({ page: '3', limit: '25' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(3);
        expect(result.data.limit).toBe(25);
      }
    });

    it('rejects page < 1', () => {
      expect(AuditQuerySchema.safeParse({ page: '0' }).success).toBe(false);
    });

    it('rejects limit > 100', () => {
      expect(AuditQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    });

    it('rejects invalid UUID for user_id', () => {
      expect(AuditQuerySchema.safeParse({ user_id: 'not-a-uuid' }).success).toBe(false);
    });
  });

  describe('healthcare type constant (from shared hipaa.ts)', () => {
    it('includes all 4 healthcare types', () => {
      expect(HIPAA_HEALTHCARE_TYPES).toContain('INSURANCE');
      expect(HIPAA_HEALTHCARE_TYPES).toContain('MEDICAL');
      expect(HIPAA_HEALTHCARE_TYPES).toContain('MEDICAL_LICENSE');
      expect(HIPAA_HEALTHCARE_TYPES).toContain('IMMUNIZATION');
    });

    it('does not include education types', () => {
      expect(HIPAA_HEALTHCARE_TYPES).not.toContain('DEGREE');
      expect(HIPAA_HEALTHCARE_TYPES).not.toContain('TRANSCRIPT');
    });
  });

  describe('healthcare event filter logic', () => {
    it('filters events by credential_type in details JSON', () => {
      const events = [
        { event_type: 'VERIFICATION_QUERIED', details: JSON.stringify({ credential_type: 'INSURANCE' }) },
        { event_type: 'VERIFICATION_QUERIED', details: JSON.stringify({ credential_type: 'DEGREE' }) },
        { event_type: 'VERIFICATION_QUERIED', details: JSON.stringify({ credential_type: 'MEDICAL' }) },
        { event_type: 'CREDENTIAL_VIEWED', details: JSON.stringify({}) },
      ];

      const healthcareEvents = events.filter((event) => {
        try {
          const details = typeof event.details === 'string' ? JSON.parse(event.details) : event.details;
          return details?.credential_type && (HIPAA_HEALTHCARE_TYPES as readonly string[]).includes(details.credential_type);
        } catch {
          return false;
        }
      });

      expect(healthcareEvents).toHaveLength(2);
    });
  });
});
