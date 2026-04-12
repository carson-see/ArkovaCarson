/**
 * Compliance Score API Tests (NCE-07)
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

vi.mock('../../compliance/auth-helpers.js', () => ({
  getCallerOrgId: vi.fn(),
}));

import { complianceScoreRouter } from './compliance-score.js';
import { db } from '../../utils/db.js';
import { getCallerOrgId } from '../../compliance/auth-helpers.js';

function buildApp(userId?: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId) req.authUserId = userId;
    next();
  });
  app.use('/api/v1/compliance/score', complianceScoreRouter);
  return app;
}

const MOCK_RULES = [{
  id: 'rule-1',
  jurisdiction_code: 'US-CA',
  industry_code: 'accounting',
  rule_name: 'California CPA Requirements',
  required_credential_types: ['LICENSE', 'CERTIFICATE'],
  optional_credential_types: ['DEGREE'],
  regulatory_reference: 'CA Bus & Prof Code §5026',
  details: { ce_hours: 80 },
}];

const MOCK_ANCHORS = [{
  id: 'anchor-1',
  credential_type: 'LICENSE',
  status: 'SECURED',
  integrity_score: 0.92,
  fraud_flags: null,
  not_after: null,
  title: 'CPA License',
}];

describe('GET /api/v1/compliance/score', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('requires jurisdiction and industry params', async () => {
    vi.mocked(getCallerOrgId).mockResolvedValue('org-1');
    const app = buildApp('user-1');
    await request(app)
      .get('/api/v1/compliance/score')
      .expect(400);
  });

  it('returns cached score if fresh', async () => {
    vi.mocked(getCallerOrgId).mockResolvedValue('org-1');

    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'compliance_scores') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  single: () => Promise.resolve({
                    data: {
                      score: 75, grade: 'C', jurisdiction_code: 'US-CA', industry_code: 'accounting',
                      present_documents: [], missing_documents: [], expiring_documents: [],
                      recommendations: [], last_calculated: new Date().toISOString(),
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        } as never;
      }
      return { select: () => ({}) } as never;
    });

    const app = buildApp('user-1');
    const res = await request(app)
      .get('/api/v1/compliance/score?jurisdiction=US-CA&industry=accounting')
      .expect(200);

    expect(res.body.score).toBe(75);
    expect(res.body.cached).toBe(true);
  });

  it('calculates fresh score when cache is stale', async () => {
    const staleDate = new Date(Date.now() - 7_200_000).toISOString();
    vi.mocked(getCallerOrgId).mockResolvedValue('org-1');

    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'compliance_scores') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  single: () => Promise.resolve({ data: { last_calculated: staleDate }, error: null }),
                }),
              }),
            }),
          }),
          upsert: () => Promise.resolve({ error: null }),
        } as never;
      }
      if (table === 'jurisdiction_rules') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ data: MOCK_RULES, error: null }),
            }),
          }),
        } as never;
      }
      if (table === 'anchors') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                limit: () => Promise.resolve({ data: MOCK_ANCHORS, error: null }),
              }),
            }),
          }),
        } as never;
      }
      return { select: () => ({}) } as never;
    });

    const app = buildApp('user-1');
    const res = await request(app)
      .get('/api/v1/compliance/score?jurisdiction=US-CA&industry=accounting')
      .expect(200);

    expect(res.body.score).toBeGreaterThan(0);
    expect(res.body.cached).toBe(false);
  });
});
