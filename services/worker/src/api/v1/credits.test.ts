/**
 * API Credit System Tests (PAY-01 / SCRUM-442)
 *
 * TDD: Tests for credit pack purchase and balance endpoints.
 * Constitution 1.7: No real Stripe calls — mock everything.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';

vi.mock('../../utils/db.js', () => ({
  db: {
    rpc: vi.fn(),
    from: vi.fn(),
  },
}));

vi.mock('../../config.js', () => ({
  config: {
    stripeSecretKey: '',
    frontendUrl: 'http://localhost:5173',
    corsAllowedOrigins: '',
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { db } from '../../utils/db.js';
import { creditsRouter, CREDIT_PACKS } from './credits.js';

function createApp(userId = 'user-1', orgId = 'org-1') {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).userId = userId;
    (req as any).orgId = orgId;
    next();
  });
  app.use('/api/v1/credits', creditsRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v1/credits', () => {
  it('returns credit balance', async () => {
    (db.rpc as any).mockResolvedValue({
      data: { monthly_allocation: 1000, used_this_month: 50, remaining: 950 },
      error: null,
    });

    const app = createApp();
    const res = await request(app).get('/api/v1/credits');

    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(950);
    expect(res.body.monthly_allocation).toBe(1000);
    expect(res.body.used_this_month).toBe(50);
    expect(res.body.packs).toHaveLength(4);
  });

  it('returns 500 on DB error', async () => {
    (db.rpc as any).mockResolvedValue({ data: null, error: { message: 'fail' } });

    const app = createApp();
    const res = await request(app).get('/api/v1/credits');
    expect(res.status).toBe(500);
  });
});

describe('POST /api/v1/credits/purchase', () => {
  it('validates pack_id', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/v1/credits/purchase')
      .send({ pack_id: 'invalid' });

    expect(res.status).toBe(400);
    expect(res.body.valid_packs).toBeDefined();
  });

  it('grants credits in dev mode (no Stripe key)', async () => {
    (db.rpc as any).mockResolvedValue({ data: null, error: null });

    const app = createApp();
    const res = await request(app)
      .post('/api/v1/credits/purchase')
      .send({ pack_id: 'pack_1k' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.credits_added).toBe(1000);
    expect(res.body.mode).toBe('development');
  });

  it('calls deduct_unified_credits with negative amount (grant)', async () => {
    (db.rpc as any).mockResolvedValue({ data: null, error: null });

    const app = createApp();
    await request(app)
      .post('/api/v1/credits/purchase')
      .send({ pack_id: 'pack_10k' });

    expect(db.rpc).toHaveBeenCalledWith('deduct_unified_credits', {
      p_org_id: 'org-1',
      p_user_id: 'user-1',
      p_amount: -10000,
    });
  });
});

describe('GET /api/v1/credits/packs', () => {
  it('lists all credit packs', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/credits/packs');

    expect(res.status).toBe(200);
    expect(res.body.packs).toHaveLength(4);
    expect(res.body.packs[0].id).toBe('pack_1k');
    expect(res.body.packs[3].id).toBe('pack_1m');
  });
});

describe('CREDIT_PACKS', () => {
  it('has correct pack definitions', () => {
    expect(CREDIT_PACKS).toHaveLength(4);
    expect(CREDIT_PACKS[0]).toMatchObject({ id: 'pack_1k', credits: 1000, price_usd: 10 });
    expect(CREDIT_PACKS[1]).toMatchObject({ id: 'pack_10k', credits: 10000, price_usd: 80 });
    expect(CREDIT_PACKS[2]).toMatchObject({ id: 'pack_100k', credits: 100000, price_usd: 500 });
    expect(CREDIT_PACKS[3]).toMatchObject({ id: 'pack_1m', credits: 1000000, price_usd: 3000 });
  });
});
