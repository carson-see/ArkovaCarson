/**
 * Compliance History API Tests (NCE-16)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn() },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { complianceHistoryRouter } from './compliance-history.js';
import { db } from '../../utils/db.js';

function buildApp(userId?: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId) req.authUserId = userId;
    next();
  });
  app.use('/api/v1/compliance/history', complianceHistoryRouter);
  return app;
}

describe('GET /api/v1/compliance/history', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('requires authentication', async () => {
    const app = buildApp();
    await request(app).get('/api/v1/compliance/history').expect(401);
  });

  it('returns history for authenticated user', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'org_members') {
        return {
          select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { org_id: 'org-1' }, error: null }) }) }),
        } as never;
      }
      if (table === 'compliance_scores') {
        return {
          select: () => ({
            eq: () => ({
              gte: () => ({
                order: () => Promise.resolve({
                  data: [
                    { score: 75, grade: 'C', jurisdiction_code: 'US-CA', industry_code: 'accounting', last_calculated: '2026-04-10T00:00:00Z' },
                    { score: 70, grade: 'C', jurisdiction_code: 'US-CA', industry_code: 'accounting', last_calculated: '2026-04-05T00:00:00Z' },
                  ],
                  error: null,
                }),
              }),
            }),
          }),
        } as never;
      }
      return { select: () => ({}) } as never;
    });

    const app = buildApp('user-1');
    const res = await request(app).get('/api/v1/compliance/history').expect(200);
    expect(res.body.history).toHaveLength(2);
    expect(res.body.period_days).toBe(90);
  });

  it('accepts custom days parameter', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'org_members') {
        return {
          select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { org_id: 'org-1' }, error: null }) }) }),
        } as never;
      }
      if (table === 'compliance_scores') {
        return {
          select: () => ({
            eq: () => ({
              gte: () => ({
                order: () => Promise.resolve({ data: [], error: null }),
              }),
            }),
          }),
        } as never;
      }
      return { select: () => ({}) } as never;
    });

    const app = buildApp('user-1');
    const res = await request(app).get('/api/v1/compliance/history?days=30').expect(200);
    expect(res.body.period_days).toBe(30);
  });
});
