/**
 * Tests for the CLE compliance-log export endpoint (SCRUM-1870 — CLE-R2).
 *
 * POST /api/v1/exports/cle-log
 *   - unauthenticated → 401
 *   - cross-user / cross-org request → 403
 *   - Zod-invalid body → 400 (incl. missing/invalid jurisdiction)
 *   - rate limit: 11th request within the hour → 429 + Retry-After
 *   - valid request → 200 with signed URLs for PDF + JSON, plus request_id
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ─── Mocks ───────────────────────────────────────────
const generateCleLogExport = vi.fn();

vi.mock('../../exports/cle-log-export.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../exports/cle-log-export.js')>();
  return {
    ...actual,
    generateCleLogExport: (...args: unknown[]) => generateCleLogExport(...args),
  };
});

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn(), storage: { from: vi.fn() } },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  config: { frontendUrl: 'https://app.arkova.io', bitcoinNetwork: 'mainnet' },
}));

import {
  cleLogExportRouter,
  cleLogExportRateLimiter,
} from './cle-log-export.js';
import { db } from '../../utils/db.js';
import { setRateLimitStore } from '../../utils/rateLimit.js';

// ─── Helpers ─────────────────────────────────────────
const SUCCESS_RESULT = {
  request_id: 'req-1',
  record_count: 2,
  disclaimer: 'disclaimer',
  exports: {
    pdf: { signed_url: 'https://storage.example/exports/x.pdf?token=a', path: 'p.pdf', expires_in: 3600 },
    json: { signed_url: 'https://storage.example/exports/x.json?token=b', path: 'p.json', expires_in: 3600 },
  },
};

function mockProfile(orgId: string | null) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue({ data: orgId ? { org_id: orgId } : null, error: null });
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: orgId ? { org_id: orgId } : null, error: null });
  return chain;
}

/**
 * Build an app that injects a fixed authenticated user (mirrors the real
 * `requireAuth` middleware that sets req.authUserId). When `userId` is
 * undefined the route must self-reject with 401.
 */
function createApp(userId: string | undefined) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId) req.authUserId = userId;
    next();
  });
  // Mount with the real rate limiter so the 429 path is exercised end-to-end.
  app.use('/exports/cle-log', cleLogExportRateLimiter, cleLogExportRouter);
  return app;
}

const VALID_BODY = {
  user_id: 'user-1',
  jurisdiction: 'CA',
  period_start: '2026-01-01',
  period_end: '2026-12-31',
  format: 'pdf',
};

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the in-memory rate-limit bucket so each test starts clean and the
  // suite is order-independent (the limiter is a module-level singleton).
  setRateLimitStore(new Map());
  generateCleLogExport.mockResolvedValue(SUCCESS_RESULT);
  (db.from as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockProfile('org-1'));
});

// ─── Auth ────────────────────────────────────────────
describe('POST /exports/cle-log — auth + scope', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(createApp(undefined)).post('/exports/cle-log').send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('returns 403 when requesting another user\'s records (cross-user)', async () => {
    const res = await request(createApp('user-1'))
      .post('/exports/cle-log')
      .send({ ...VALID_BODY, user_id: 'someone-else' });
    expect(res.status).toBe(403);
    expect(generateCleLogExport).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller has no organization membership', async () => {
    (db.from as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockProfile(null));
    const res = await request(createApp('user-1')).post('/exports/cle-log').send(VALID_BODY);
    expect(res.status).toBe(403);
  });
});

// ─── Validation ──────────────────────────────────────
describe('POST /exports/cle-log — Zod validation', () => {
  it('returns 400 with structured details on an invalid body', async () => {
    const res = await request(createApp('user-1'))
      .post('/exports/cle-log')
      .send({ ...VALID_BODY, period_start: 'not-a-date' });
    expect(res.status).toBe(400);
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it('returns 400 on an unsupported format', async () => {
    const res = await request(createApp('user-1'))
      .post('/exports/cle-log')
      .send({ ...VALID_BODY, format: 'xlsx' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when jurisdiction is missing', async () => {
    const { jurisdiction: _omit, ...noJurisdiction } = VALID_BODY;
    const res = await request(createApp('user-1'))
      .post('/exports/cle-log')
      .send(noJurisdiction);
    expect(res.status).toBe(400);
  });

  it('returns 400 when jurisdiction is not a US state code', async () => {
    const res = await request(createApp('user-1'))
      .post('/exports/cle-log')
      .send({ ...VALID_BODY, jurisdiction: 'California' });
    expect(res.status).toBe(400);
  });

  it('accepts the US-prefixed jurisdiction form (US-CA)', async () => {
    const res = await request(createApp('user-1'))
      .post('/exports/cle-log')
      .send({ ...VALID_BODY, jurisdiction: 'US-CA' });
    expect(res.status).toBe(200);
  });

  it('returns 400 when period_end precedes period_start', async () => {
    const res = await request(createApp('user-1'))
      .post('/exports/cle-log')
      .send({ ...VALID_BODY, period_start: '2026-12-31', period_end: '2026-01-01' });
    expect(res.status).toBe(400);
  });
});

// ─── Happy path ──────────────────────────────────────
describe('POST /exports/cle-log — success', () => {
  it('returns 200 with signed URLs for BOTH formats + request_id', async () => {
    const res = await request(createApp('user-1')).post('/exports/cle-log').send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body.exports.pdf.signed_url).toMatch(/^https:\/\//);
    expect(res.body.exports.json.signed_url).toMatch(/^https:\/\//);
    expect(typeof res.body.request_id).toBe('string');
    expect(res.body.record_count).toBe(2);
    expect(generateCleLogExport).toHaveBeenCalledTimes(1);
  });

  it('passes user/org/jurisdiction + a generated request_id through to the worker', async () => {
    await request(createApp('user-1')).post('/exports/cle-log').send(VALID_BODY);
    const args = generateCleLogExport.mock.calls[0][0];
    expect(args.userId).toBe('user-1');
    expect(args.orgId).toBe('org-1');
    expect(args.jurisdiction).toBe('CA');
    expect(typeof args.requestId).toBe('string');
    expect(args.requestId.length).toBeGreaterThan(0);
  });

  it('returns 500 (not an unhandled throw) when the worker fails', async () => {
    generateCleLogExport.mockRejectedValueOnce(new Error('boom'));
    const res = await request(createApp('user-1')).post('/exports/cle-log').send(VALID_BODY);
    expect(res.status).toBe(500);
  });
});

// ─── Rate limit ──────────────────────────────────────
describe('POST /exports/cle-log — rate limit (10/user/hour)', () => {
  it('allows 10 requests then 429s the 11th within the hour, with Retry-After', async () => {
    const app = createApp('rate-user-cle');
    (db.from as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockProfile('org-1'));

    for (let i = 0; i < 10; i++) {
      const ok = await request(app)
        .post('/exports/cle-log')
        .send({ ...VALID_BODY, user_id: 'rate-user-cle' });
      expect(ok.status).toBe(200);
    }

    const limited = await request(app)
      .post('/exports/cle-log')
      .send({ ...VALID_BODY, user_id: 'rate-user-cle' });
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });
});
