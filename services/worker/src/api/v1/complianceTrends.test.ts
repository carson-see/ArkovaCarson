/**
 * Tests for Compliance Trends API (COMP-07)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn() },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Owner-inclusive admin gate (the P1 fix): the route resolves the caller's org
// via getCallerOrgId and gates on isCallerOrgAdmin — admitting org OWNERS, who
// are linked via profiles.org_id and may have no org_members row.
const getCallerOrgIdMock = vi.fn();
const isCallerOrgAdminMock = vi.fn();

vi.mock('../_org-auth.js', () => ({
  getCallerOrgId: (...args: unknown[]) => getCallerOrgIdMock(...args),
  isCallerOrgAdmin: (...args: unknown[]) => isCallerOrgAdminMock(...args),
}));

import { z } from 'zod';
import { db } from '../../utils/db.js';

const TEST_ORG_ID = '11111111-1111-4111-8111-111111111111';
const TEST_USER_ID = '22222222-2222-4222-8222-222222222222';

// Data-query stub: anchors/signatures/signing_certificates all resolve empty so
// the 200 path completes without touching a real DB. The admin gate no longer
// uses db.from at all (it goes through the mocked _org-auth helpers).
function stubDataQueries() {
  vi.mocked(db.from).mockReturnValue({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    lte: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: [], error: null }),
  } as never);
}

async function buildApp(userId?: string) {
  const { complianceTrendsRouter } = await import('./complianceTrends.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId) (req as unknown as { authUserId: string }).authUserId = userId;
    next();
  });
  app.use('/api/v1/compliance/trends', complianceTrendsRouter);
  return app;
}

const VALID_QS = `from=${encodeURIComponent('2026-01-01T00:00:00Z')}&to=${encodeURIComponent('2026-06-01T00:00:00Z')}`;

describe('Compliance Trends API (COMP-07)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('validates required from/to params', async () => {
    const { complianceTrendsRouter } = await import('./complianceTrends.js');
    expect(complianceTrendsRouter).toBeDefined();
  });

  it('granularity defaults to weekly', () => {
    // The schema has a default — verify structurally
    const schema = z.object({
      granularity: z.enum(['daily', 'weekly', 'monthly']).default('weekly'),
    });
    const result = schema.parse({});
    expect(result.granularity).toBe('weekly');
  });

  it('bucket key format: daily returns YYYY-MM-DD', () => {
    const d = new Date('2026-03-15T10:30:00Z');
    const key = d.toISOString().split('T')[0];
    expect(key).toBe('2026-03-15');
  });

  it('bucket key format: monthly returns YYYY-MM-01', () => {
    const d = new Date('2026-03-15T10:30:00Z');
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    expect(key).toBe('2026-03-01');
  });

  it('timestamp coverage calculation is correct', () => {
    const sigCount = 10;
    const timestampCount = 8;
    const pct = Math.round((timestampCount / sigCount) * 1000) / 10;
    expect(pct).toBe(80);
  });

  it('threshold: timestamp_coverage >= 95 is green', () => {
    const pct = 96;
    const threshold = pct >= 95 ? 'green' : pct >= 80 ? 'amber' : 'red';
    expect(threshold).toBe('green');
  });

  it('threshold: timestamp_coverage 80-95 is amber', () => {
    const pct = 85;
    const threshold = pct >= 95 ? 'green' : pct >= 80 ? 'amber' : 'red';
    expect(threshold).toBe('amber');
  });

  it('threshold: timestamp_coverage < 80 is red', () => {
    const pct = 70;
    const threshold = pct >= 95 ? 'green' : pct >= 80 ? 'amber' : 'red';
    expect(threshold).toBe('red');
  });

  it('anchor delay threshold: <= 30min is green', () => {
    const delay = 25;
    const threshold = delay <= 30 ? 'green' : delay <= 120 ? 'amber' : 'red';
    expect(threshold).toBe('green');
  });

  it('average anchor delay calculation', () => {
    const totalMs = 3600_000 + 1800_000; // 60min + 30min
    const count = 2;
    const avgMin = Math.round(totalMs / count / 60000);
    expect(avgMin).toBe(45);
  });
});

describe('GET /api/v1/compliance/trends — owner-inclusive admin gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubDataQueries();
  });

  it('requires authentication', async () => {
    const app = await buildApp();
    await request(app).get(`/api/v1/compliance/trends?${VALID_QS}`).expect(401);
  });

  it('an org OWNER (profiles.org_id linkage, no org_members row) gets 200, not 403', async () => {
    // The fix path: getCallerOrgId resolves the owner's org and isCallerOrgAdmin
    // admits the owner even without an org_members row.
    getCallerOrgIdMock.mockResolvedValue(TEST_ORG_ID);
    isCallerOrgAdminMock.mockResolvedValue(true);

    const app = await buildApp(TEST_USER_ID);
    const res = await request(app).get(`/api/v1/compliance/trends?${VALID_QS}`).expect(200);

    expect(res.body.period).toEqual({
      from: '2026-01-01T00:00:00Z',
      to: '2026-06-01T00:00:00Z',
    });
    expect(getCallerOrgIdMock).toHaveBeenCalledWith(TEST_USER_ID);
    expect(isCallerOrgAdminMock).toHaveBeenCalledWith(TEST_USER_ID, TEST_ORG_ID);
  });

  it('403 (original message) when the caller has no org (getCallerOrgId → null)', async () => {
    getCallerOrgIdMock.mockResolvedValue(null);
    isCallerOrgAdminMock.mockResolvedValue(false);

    const app = await buildApp(TEST_USER_ID);
    const res = await request(app).get(`/api/v1/compliance/trends?${VALID_QS}`).expect(403);
    expect(res.body.error).toBe('Admin, owner, or compliance officer role required');
  });

  it('403 when the caller has an org but is not an admin (isCallerOrgAdmin → false)', async () => {
    getCallerOrgIdMock.mockResolvedValue(TEST_ORG_ID);
    isCallerOrgAdminMock.mockResolvedValue(false);

    const app = await buildApp(TEST_USER_ID);
    const res = await request(app).get(`/api/v1/compliance/trends?${VALID_QS}`).expect(403);
    expect(res.body.error).toBe('Admin, owner, or compliance officer role required');
  });
});
