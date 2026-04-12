/**
 * Jurisdiction Rules API Tests (NCE-06)
 *
 * GET /api/v1/compliance/rules — public read of jurisdiction requirements
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock db before import
vi.mock('../../utils/db.js', () => ({
  db: {
    from: vi.fn(),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { complianceRulesRouter } from './compliance-rules.js';
import { db } from '../../utils/db.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/compliance/rules', complianceRulesRouter);
  return app;
}

const MOCK_RULES = [
  {
    id: 'rule-1',
    jurisdiction_code: 'US-CA',
    industry_code: 'accounting',
    rule_name: 'California CPA Requirements',
    required_credential_types: ['LICENSE', 'CERTIFICATE', 'CONTINUING_EDUCATION'],
    optional_credential_types: ['DEGREE'],
    regulatory_reference: 'CA Bus & Prof Code §5026',
    effective_date: null,
    expiry_date: null,
    details: { ce_hours: 80, ce_cycle_years: 2 },
    created_at: '2026-04-12T00:00:00Z',
    updated_at: '2026-04-12T00:00:00Z',
  },
];

describe('GET /api/v1/compliance/rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns rules for valid jurisdiction + industry', async () => {
    const mockSelect = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: MOCK_RULES, error: null }),
      }),
    });
    vi.mocked(db.from).mockReturnValue({ select: mockSelect } as never);

    const app = buildApp();
    const res = await request(app)
      .get('/api/v1/compliance/rules?jurisdiction=US-CA&industry=accounting')
      .expect(200);

    expect(res.body.rules).toHaveLength(1);
    expect(res.body.rules[0].jurisdiction_code).toBe('US-CA');
    expect(res.body.rules[0].required_credential_types).toContain('LICENSE');
  });

  it('returns rules filtered by jurisdiction only', async () => {
    const mockEq = vi.fn().mockResolvedValue({ data: MOCK_RULES, error: null });
    const mockSelect = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({ eq: mockEq }),
    });
    // When only jurisdiction is provided, we chain one .eq()
    const mockSelectSingle = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ data: MOCK_RULES, error: null }),
    });
    vi.mocked(db.from).mockReturnValue({ select: mockSelectSingle } as never);

    const app = buildApp();
    const res = await request(app)
      .get('/api/v1/compliance/rules?jurisdiction=US-CA')
      .expect(200);

    expect(res.body.rules).toBeDefined();
  });

  it('returns all rules when no filters provided', async () => {
    const mockSelect = vi.fn().mockResolvedValue({ data: MOCK_RULES, error: null });
    vi.mocked(db.from).mockReturnValue({ select: mockSelect } as never);

    const app = buildApp();
    const res = await request(app)
      .get('/api/v1/compliance/rules')
      .expect(200);

    expect(res.body.rules).toBeDefined();
  });

  it('rejects invalid jurisdiction code', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/v1/compliance/rules?jurisdiction=' + 'X'.repeat(51))
      .expect(400);

    expect(res.body.error).toBeDefined();
  });

  it('handles database errors gracefully', async () => {
    const mockSelect = vi.fn().mockResolvedValue({ data: null, error: { message: 'DB error' } });
    vi.mocked(db.from).mockReturnValue({ select: mockSelect } as never);

    const app = buildApp();
    const res = await request(app)
      .get('/api/v1/compliance/rules')
      .expect(500);

    expect(res.body.error).toBeDefined();
  });
});
