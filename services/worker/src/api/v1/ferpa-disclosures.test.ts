/**
 * Tests for FERPA Disclosure Log API — REG-01 (SCRUM-561).
 *
 * SECURITY REGRESSION COVERAGE (fix, 2026-07-28): all three routes previously
 * read `x-org-id` directly off the request with NO membership check — any
 * authenticated user could read/write ANY org's FERPA disclosure log by
 * supplying an arbitrary header. They now go through the membership-
 * validating `requireOrgId` (POST) and additionally `requireOrgAdmin` (the
 * two GET routes, per the docstring's "admin/compliance_officer only"
 * intent). `_org-auth.js` is mocked so each test drives the authorization
 * decision directly — see `requireOrgId.test.ts` / `requireOrgAdmin.test.ts`
 * for the middleware's own unit coverage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ─── Org-auth resolver (the fix under test drives these) ─────────────────
const isUserMemberOfOrgResult = vi.fn();
const isCallerOrgAdminResult = vi.fn();

vi.mock('../_org-auth.js', () => ({
  isUserMemberOfOrgResult: (...args: unknown[]) => isUserMemberOfOrgResult(...args),
  isCallerOrgAdminResult: (...args: unknown[]) => isCallerOrgAdminResult(...args),
}));

// Mock db before importing router
vi.mock('../../utils/db.js', () => {
  const mockSelect = vi.fn().mockReturnThis();
  const mockInsert = vi.fn().mockReturnThis();
  const mockEq = vi.fn().mockReturnThis();
  const mockOrder = vi.fn().mockReturnThis();
  const mockRange = vi.fn().mockReturnThis();
  const mockGte = vi.fn().mockReturnThis();
  const mockLte = vi.fn().mockReturnThis();
  const mockSingle = vi.fn();

  const mockFrom = vi.fn().mockReturnValue({
    select: mockSelect,
    insert: mockInsert,
    eq: mockEq,
    order: mockOrder,
    range: mockRange,
    gte: mockGte,
    lte: mockLte,
    single: mockSingle,
  });

  // Chain methods also return the query builder
  mockSelect.mockReturnValue({
    eq: mockEq,
    order: mockOrder,
    range: mockRange,
    gte: mockGte,
    lte: mockLte,
    single: mockSingle,
  });

  mockInsert.mockReturnValue({
    select: vi.fn().mockReturnValue({
      single: mockSingle,
    }),
  });

  mockEq.mockReturnValue({
    eq: mockEq,
    order: mockOrder,
    range: mockRange,
    gte: mockGte,
    lte: mockLte,
  });

  mockOrder.mockReturnValue({
    range: mockRange,
    gte: mockGte,
    lte: mockLte,
  });

  mockRange.mockResolvedValue({
    data: [],
    error: null,
    count: 0,
  });

  mockSingle.mockResolvedValue({
    data: { id: 'test-id', disclosed_at: '2026-04-12T00:00:00Z' },
    error: null,
  });

  return {
    db: { from: mockFrom },
    _mocks: { mockFrom, mockInsert, mockSelect, mockSingle, mockRange },
  };
});

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import ferpaRouter from './ferpa-disclosures.js';
import { db } from '../../utils/db.js';

function createApp(userId: string | null = 'user-org-A') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId) req.authUserId = userId;
    next();
  });
  app.use('/api/v1/ferpa', ferpaRouter);
  return app;
}

/** Default: caller is a member AND admin of the org named in the header. */
function asMemberAndAdmin() {
  isUserMemberOfOrgResult.mockResolvedValue({ value: true, error: false });
  isCallerOrgAdminResult.mockResolvedValue({ value: true, error: false });
}

describe('FERPA Disclosure Log API', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    asMemberAndAdmin();
    app = createApp();
  });

  describe('POST /api/v1/ferpa/disclosures', () => {
    const validBody = {
      requesting_party_name: 'Jane Smith',
      requesting_party_type: 'school_official',
      legitimate_interest: 'Enrollment verification for transfer student',
      disclosure_exception: '99.31(a)(2)',
      education_record_ids: ['ARK-2026-001', 'ARK-2026-002'],
      student_opt_out_checked: true,
    };

    it('returns 401 when unauthenticated', async () => {
      const res = await request(createApp(null))
        .post('/api/v1/ferpa/disclosures')
        .set('x-org-id', 'org-A')
        .send(validBody);
      expect(res.status).toBe(401);
    });

    it('returns 400 when x-org-id header is missing', async () => {
      const res = await request(app)
        .post('/api/v1/ferpa/disclosures')
        .send(validBody);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('x-org-id header required');
    });

    // ─── Cross-tenant isolation (KEY DELIVERABLE) ───────────────────────
    it('org-A caller writing to org-B header is REJECTED (403), never trusted', async () => {
      isUserMemberOfOrgResult.mockResolvedValue({ value: false, error: false });
      const res = await request(app)
        .post('/api/v1/ferpa/disclosures')
        .set('x-org-id', 'org-B')
        .send(validBody);

      expect(res.status).toBe(403);
      expect(isUserMemberOfOrgResult).toHaveBeenCalledWith('user-org-A', 'org-B');
      expect(db.from).not.toHaveBeenCalledWith('ferpa_disclosure_log');
    });

    it('legitimate same-org caller still succeeds (201)', async () => {
      const res = await request(app)
        .post('/api/v1/ferpa/disclosures')
        .set('x-org-id', 'org-A')
        .send(validBody);

      expect(res.status).toBe(201);
      expect(isUserMemberOfOrgResult).toHaveBeenCalledWith('user-org-A', 'org-A');
    });

    it('returns 400 when body validation fails', async () => {
      const res = await request(app)
        .post('/api/v1/ferpa/disclosures')
        .set('x-org-id', 'org-A')
        .send({ requesting_party_name: '' }); // missing required fields

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 400 when education_record_ids is empty', async () => {
      const res = await request(app)
        .post('/api/v1/ferpa/disclosures')
        .set('x-org-id', 'org-A')
        .send({ ...validBody, education_record_ids: [] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 201 with valid body and org-id', async () => {
      const res = await request(app)
        .post('/api/v1/ferpa/disclosures')
        .set('x-org-id', 'org-A')
        .send(validBody);

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('test-id');
      expect(res.body.message).toContain('Section 99.32');
      expect(db.from).toHaveBeenCalledWith('ferpa_disclosure_log');
    });

    it('validates party_type enum', async () => {
      const res = await request(app)
        .post('/api/v1/ferpa/disclosures')
        .set('x-org-id', 'org-A')
        .send({ ...validBody, requesting_party_type: 'invalid_type' });

      expect(res.status).toBe(400);
    });

    it('validates exception category enum', async () => {
      const res = await request(app)
        .post('/api/v1/ferpa/disclosures')
        .set('x-org-id', 'org-A')
        .send({ ...validBody, disclosure_exception: 'invalid_exception' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/ferpa/disclosures — ORG_ADMIN gate', () => {
    it('returns 400 when x-org-id header is missing', async () => {
      const res = await request(app).get('/api/v1/ferpa/disclosures');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('x-org-id header required');
    });

    it('returns 403 when the caller is a member but NOT an org admin', async () => {
      isCallerOrgAdminResult.mockResolvedValue({ value: false, error: false });
      const res = await request(app)
        .get('/api/v1/ferpa/disclosures')
        .set('x-org-id', 'org-A');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Organization administrator role required');
    });

    // ─── Cross-tenant isolation (KEY DELIVERABLE) ───────────────────────
    it('org-A admin reading org-B header is REJECTED (403), never trusted', async () => {
      isUserMemberOfOrgResult.mockResolvedValue({ value: false, error: false });
      const res = await request(app)
        .get('/api/v1/ferpa/disclosures')
        .set('x-org-id', 'org-B');
      expect(res.status).toBe(403);
      expect(db.from).not.toHaveBeenCalledWith('ferpa_disclosure_log');
    });

    it('legitimate same-org ORG_ADMIN caller still succeeds (200)', async () => {
      const res = await request(app)
        .get('/api/v1/ferpa/disclosures')
        .set('x-org-id', 'org-A');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('disclosures');
      expect(res.body).toHaveProperty('total');
      expect(res.body).toHaveProperty('page');
      expect(res.body).toHaveProperty('limit');
    });

    it('validates invalid page parameter', async () => {
      const res = await request(app)
        .get('/api/v1/ferpa/disclosures?page=0')
        .set('x-org-id', 'org-A');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });
  });

  describe('GET /api/v1/ferpa/disclosures/export — ORG_ADMIN gate', () => {
    beforeEach(() => {
      const mockFrom = vi.mocked(db.from);
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
              gte: vi.fn().mockReturnValue({
                lte: vi.fn().mockResolvedValue({
                  data: [
                    {
                      disclosed_at: '2026-04-12T00:00:00Z',
                      requesting_party_name: 'Jane Smith',
                      requesting_party_type: 'school_official',
                      requesting_party_org: 'State University',
                      legitimate_interest: 'Transfer verification',
                      disclosure_exception: '99.31(a)(2)',
                      education_record_ids: ['ARK-001'],
                      student_opt_out_checked: true,
                      student_consent_obtained: false,
                      notes: null,
                    },
                  ],
                  error: null,
                }),
              }),
              lte: vi.fn().mockResolvedValue({
                data: [],
                error: null,
              }),
            }),
            }),
          }),
        }),
      } as never);
    });

    it('returns 400 when x-org-id header is missing', async () => {
      const res = await request(app).get('/api/v1/ferpa/disclosures/export');

      expect(res.status).toBe(400);
    });

    it('returns 403 when the caller is a member but NOT an org admin', async () => {
      isCallerOrgAdminResult.mockResolvedValue({ value: false, error: false });
      const res = await request(app)
        .get('/api/v1/ferpa/disclosures/export')
        .set('x-org-id', 'org-A');
      expect(res.status).toBe(403);
    });

    // ─── Cross-tenant isolation (KEY DELIVERABLE) ───────────────────────
    it('org-A admin exporting org-B header is REJECTED (403), never trusted', async () => {
      isUserMemberOfOrgResult.mockResolvedValue({ value: false, error: false });
      const res = await request(app)
        .get('/api/v1/ferpa/disclosures/export')
        .set('x-org-id', 'org-B');
      expect(res.status).toBe(403);
    });

    it('legitimate same-org ORG_ADMIN caller still gets the CSV (200)', async () => {
      const res = await request(app)
        .get('/api/v1/ferpa/disclosures/export')
        .set('x-org-id', 'org-A');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('ferpa-disclosures');
    });
  });
});
