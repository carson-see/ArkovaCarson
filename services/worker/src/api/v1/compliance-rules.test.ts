/**
 * Jurisdiction Rules API Tests (NCE-06)
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

import { complianceRulesRouter } from './compliance-rules.js';
import { db } from '../../utils/db.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/compliance/rules', complianceRulesRouter);
  return app;
}

const MOCK_RULES = [{
  id: 'rule-1',
  jurisdiction_code: 'US-CA',
  industry_code: 'accounting',
  rule_name: 'California CPA Requirements',
  required_credential_types: ['LICENSE', 'CERTIFICATE', 'CONTINUING_EDUCATION'],
  optional_credential_types: ['DEGREE'],
  regulatory_reference: 'CA Bus & Prof Code §5026',
  details: { ce_hours: 80, ce_cycle_years: 2 },
}];

/** Build a chainable mock that resolves at the end of any chain */
function mockChain(result: { data: unknown; error: unknown }) {
  const handler: Record<string, unknown> = {};
  const proxy = new Proxy(handler, {
    get: (_target, prop) => {
      if (prop === 'then') return undefined; // not a thenable
      return (..._args: unknown[]) => {
        // Terminal — return a promise-like that also chains
        const terminal = Promise.resolve(result);
        return Object.assign(terminal, {
          eq: () => terminal,
          limit: () => terminal,
          select: () => terminal,
        });
      };
    },
  });
  return { select: () => proxy };
}

describe('GET /api/v1/compliance/rules', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns rules for valid jurisdiction + industry', async () => {
    vi.mocked(db.from).mockReturnValue(mockChain({ data: MOCK_RULES, error: null }) as never);
    const app = buildApp();
    const res = await request(app)
      .get('/api/v1/compliance/rules?jurisdiction=US-CA&industry=accounting')
      .expect(200);

    expect(res.body.rules).toHaveLength(1);
    expect(res.body.rules[0].jurisdiction_code).toBe('US-CA');
  });

  it('returns rules filtered by jurisdiction only', async () => {
    vi.mocked(db.from).mockReturnValue(mockChain({ data: MOCK_RULES, error: null }) as never);
    const app = buildApp();
    const res = await request(app)
      .get('/api/v1/compliance/rules?jurisdiction=US-CA')
      .expect(200);

    expect(res.body.rules).toBeDefined();
  });

  it('returns all rules when no filters provided', async () => {
    vi.mocked(db.from).mockReturnValue(mockChain({ data: MOCK_RULES, error: null }) as never);
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
    vi.mocked(db.from).mockReturnValue(mockChain({ data: null, error: { message: 'DB error' } }) as never);
    const app = buildApp();
    const res = await request(app)
      .get('/api/v1/compliance/rules')
      .expect(500);

    expect(res.body.error).toBeDefined();
  });
});
