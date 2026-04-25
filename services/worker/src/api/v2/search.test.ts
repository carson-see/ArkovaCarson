import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSelect = vi.fn().mockReturnThis();
const mockOr = vi.fn().mockReturnThis();
const mockIlike = vi.fn().mockReturnThis();
const mockEq = vi.fn().mockReturnThis();
const mockIn = vi.fn().mockReturnThis();
const mockIs = vi.fn().mockReturnThis();
const mockNot = vi.fn().mockReturnThis();
const mockRange = vi.fn().mockReturnThis();
const mockOrder = vi.fn().mockResolvedValue({ data: [], error: null });

vi.mock('../../utils/db.js', () => ({
  db: {
    from: vi.fn(() => ({
      select: mockSelect,
      or: mockOr,
      ilike: mockIlike,
      eq: mockEq,
      in: mockIn,
      is: mockIs,
      not: mockNot,
      range: mockRange,
      order: mockOrder,
    })),
  },
}));

vi.mock('../../config.js', () => ({
  config: { nodeEnv: 'test', apiKeyHmacSecret: 'test-secret' },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../middleware/featureGate.js', () => ({
  verificationApiGate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../middleware/apiKeyAuth.js', () => ({
  apiKeyAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import express from 'express';
import request from 'supertest';
import { buildSearchHandler, searchRouter } from './search.js';
import { v2ErrorHandler } from './problem.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.apiKey = {
      keyId: 'k1',
      orgId: 'org1',
      userId: 'u1',
      scopes: ['read:search'],
      rateLimitTier: 'paid',
      keyPrefix: 'ak_test_',
    };
    next();
  });
  app.use('/search', searchRouter);
  app.use(v2ErrorHandler);
  return app;
}

describe('GET /api/v2/search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrder.mockResolvedValue({ data: [], error: null });
  });

  it('returns empty results for no matches', async () => {
    const app = buildApp();
    const res = await request(app).get('/search?q=nonexistent');
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
    expect(res.body.next_cursor).toBeNull();
  });

  it('validates missing q parameter', async () => {
    const app = buildApp();
    const res = await request(app).get('/search');
    expect(res.status).toBe(400);
    expect(res.body.type).toContain('validation-error');
  });

  it('supports type=org filter', async () => {
    mockOrder.mockResolvedValueOnce({
      data: [{
        id: '1',
        public_id: 'org_acme',
        display_name: 'Acme Corp',
        description: 'A company',
        domain: 'acme.com',
        website_url: 'https://acme.com',
      }],
      error: null,
    });

    const app = buildApp();
    const res = await request(app).get('/search?q=acme&type=org');
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].type).toBe('org');
    expect(res.body.results[0].public_id).toBe('org_acme');
    // Constitutional check (CLAUDE.md §6): never expose internal id publicly.
    expect(res.body.results[0].id).toBeUndefined();
  });

  it('drops rows with null public_id (defense-in-depth for CLAUDE.md §6)', async () => {
    // The DB query already adds .not('public_id','is',null) but the row TYPE
    // is still nullable. The post-map() filter must drop any row that slips
    // through (e.g. legacy rows pre-public_id backfill) so we never expose an
    // internal UUID under public_id.
    mockOrder.mockResolvedValueOnce({
      data: [
        { id: 'leaky-1', public_id: null, display_name: 'Legacy Org', description: null, domain: null, website_url: null },
        { id: 'good-1', public_id: 'org_keep', display_name: 'Keep Me', description: null, domain: null, website_url: null },
      ],
      error: null,
    });

    const app = buildApp();
    const res = await request(app).get('/search?q=acme&type=org');
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].public_id).toBe('org_keep');
    expect(JSON.stringify(res.body)).not.toContain('leaky-1');
  });

  it('supports type=all across orgs, records, fingerprints, and documents', async () => {
    mockOrder
      .mockResolvedValueOnce({
        data: [{
          id: 'org-1',
          public_id: 'org_acme',
          display_name: 'Acme Corp',
          description: 'A company',
          domain: 'acme.com',
          website_url: 'https://acme.com',
        }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{ id: 'rec-1', public_id: 'ARK-1', filename: 'Acme Record.pdf', credential_type: 'LEGAL', status: 'SECURED', fingerprint: 'fp1' }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{ id: 'fp-1', public_id: 'ARK-FP', fingerprint: 'acme', filename: 'Fingerprint.pdf', status: 'SECURED' }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{ id: 'doc-1', public_id: 'ARK-DOC', filename: 'Offer Letter.pdf', description: 'Acme', credential_type: 'LEGAL', status: 'PENDING' }],
        error: null,
      });

    const app = buildApp();
    const res = await request(app).get('/search?q=acme&type=all&limit=8');

    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { type: string }) => r.type)).toEqual([
      'org',
      'record',
      'fingerprint',
      'document',
    ]);
  });

  it('supports type=fingerprint with exact match', async () => {
    const fp = 'abc123def456';
    mockOrder.mockResolvedValueOnce({
      data: [{ id: '2', public_id: 'pk_2', fingerprint: fp, filename: 'Test Doc.pdf', status: 'SECURED' }],
      error: null,
    });

    const app = buildApp();
    const res = await request(app).get(`/search?q=${fp}&type=fingerprint`);
    expect(res.status).toBe(200);
    expect(res.body.results[0].type).toBe('fingerprint');
    expect(mockOr).toHaveBeenCalledWith('status.eq.SECURED,org_id.eq.org1');
  });

  it('supports cursor-based pagination', async () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      id: `${i}`, public_id: `pk_${i}`, filename: `Doc ${i}.pdf`, credential_type: 'DEGREE', status: 'SECURED', fingerprint: `fp${i}`,
    }));
    mockOrder.mockResolvedValueOnce({ data: items, error: null });

    const app = buildApp();
    const res = await request(app).get('/search?q=Doc&type=record&limit=50');
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(50);
    expect(res.body.next_cursor).toBeTruthy();
  });

  it('returns null cursor when results < limit', async () => {
    mockOrder.mockResolvedValueOnce({
      data: [{ id: '1', public_id: 'pk_1', filename: 'Only One.pdf', credential_type: 'LICENSE', status: 'SECURED', fingerprint: 'fp1' }],
      error: null,
    });

    const app = buildApp();
    const res = await request(app).get('/search?q=One&type=record&limit=50');
    expect(res.body.next_cursor).toBeNull();
  });

  it('rejects scope-less API key', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.apiKey = {
        keyId: 'k1',
        orgId: 'org1',
        userId: 'u1',
        scopes: [],
        rateLimitTier: 'free',
        keyPrefix: 'ak_test_',
      };
      next();
    });
    app.use('/search', searchRouter);
    app.use(v2ErrorHandler);

    const res = await request(app).get('/search?q=test');
    expect(res.status).toBe(403);
    expect(res.body.type).toContain('invalid-scope');
  });

  it('validates limit range', async () => {
    const app = buildApp();
    const res = await request(app).get('/search?q=test&limit=200');
    expect(res.status).toBe(400);
  });

  it('supports direct resource search aliases', async () => {
    mockOrder.mockResolvedValueOnce({
      data: [{
        id: '1',
        public_id: 'org_acme',
        display_name: 'Acme Corp',
        description: 'A company',
        domain: 'acme.com',
        website_url: 'https://acme.com',
      }],
      error: null,
    });

    const app = express();
    app.use('/organizations', buildSearchHandler('org'));
    app.use(v2ErrorHandler);

    const res = await request(app).get('/organizations?q=acme');
    expect(res.status).toBe(200);
    expect(res.body.results[0].type).toBe('org');
    expect(mockOr).toHaveBeenCalledWith(expect.stringContaining('display_name.ilike'));
  });

  it('scopes document search to public secured records plus the API key org', async () => {
    mockOrder.mockResolvedValueOnce({
      data: [{ id: '2', public_id: 'pk_2', filename: 'Contract.pdf', credential_type: 'LEGAL', status: 'PENDING' }],
      error: null,
    });

    const app = buildApp();
    const res = await request(app).get('/search?q=Contract&type=document');

    expect(res.status).toBe(200);
    expect(mockIn).toHaveBeenCalledWith('status', ['SECURED', 'SUBMITTED', 'PENDING']);
    expect(mockIs).toHaveBeenCalledWith('deleted_at', null);
    expect(mockOr).toHaveBeenCalledWith('status.eq.SECURED,org_id.eq.org1');
    expect(mockOr).toHaveBeenCalledWith(expect.stringContaining('metadata->>issuer.ilike'));
  });

  it('keeps synthetic 10K-row p95 latency below 200ms', async () => {
    const app = buildApp();
    const catalog = Array.from({ length: 10_000 }, (_, i) => ({
      id: `record-${i}`,
      public_id: `ARK-${i}`,
      filename: `Record ${i}.pdf`,
      credential_type: 'LEGAL',
      status: 'SECURED',
      fingerprint: `fp-${i}`,
    }));
    const durations: number[] = [];

    for (let i = 0; i < 20; i += 1) {
      mockOrder.mockResolvedValueOnce({ data: catalog.slice(i, i + 50), error: null });
      const started = performance.now();
      const res = await request(app).get('/search?q=Record&type=record&limit=50');
      durations.push(performance.now() - started);
      expect(res.status).toBe(200);
    }

    const p95 = durations.slice().sort((a: number, b: number) => a - b)[Math.floor(durations.length * 0.95) - 1];
    expect(p95).toBeLessThan(200);
  });
});
