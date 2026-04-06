/**
 * Payment Tier Router Tests (PAY-03 / SCRUM-444)
 *
 * TDD: Tests written for three-tier payment resolution.
 * Constitution 1.7: No real Stripe or Bitcoin calls — mock everything.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';

vi.mock('../utils/db.js', () => ({
  db: {
    rpc: vi.fn(),
    from: vi.fn(),
  },
}));

vi.mock('../config.js', () => ({
  config: {
    nodeEnv: 'development',
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { db } from '../utils/db.js';
import { paymentTierRouter } from './paymentTierRouter.js';

function createApp(userId?: string, orgId?: string) {
  const app = express();
  app.use(express.json());

  // Simulate auth middleware
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (userId) (req as any).userId = userId;
    if (orgId) (req as any).orgId = orgId;
    next();
  });

  app.use(paymentTierRouter());

  app.get('/api/v1/verify/:id', (req: Request, res: Response) => {
    res.json({ ok: true, tier: (req as any).paymentResolution?.tier });
  });

  app.post('/api/v1/ai/extract', (req: Request, res: Response) => {
    res.json({ ok: true, tier: (req as any).paymentResolution?.tier });
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'healthy' });
  });

  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('paymentTierRouter', () => {
  describe('bypass paths', () => {
    it('should skip payment check for /health', async () => {
      const app = createApp();
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('healthy');
    });

    it('should pass through when no userId (let auth middleware handle)', async () => {
      const app = createApp();
      const res = await request(app).get('/api/v1/verify/test');
      expect(res.status).toBe(200);
    });
  });

  describe('tier 0: admin bypass', () => {
    it('should authorize admin users without payment', async () => {
      (db.from as any).mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: { is_platform_admin: true }, error: null }),
          }),
        }),
      });

      const app = createApp('admin-123', 'org-1');
      const res = await request(app).get('/api/v1/verify/test');
      expect(res.status).toBe(200);
      expect(res.body.tier).toBe('admin_bypass');
    });
  });

  describe('tier 0: beta unlimited', () => {
    it('should authorize when beta mode is active', async () => {
      (db.from as any).mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: { is_platform_admin: false }, error: null }),
          }),
        }),
      });
      (db.rpc as any)
        .mockResolvedValueOnce({ data: null, error: null }); // check_anchor_quota → NULL = unlimited

      const app = createApp('user-1', 'org-1');
      const res = await request(app).get('/api/v1/verify/test');
      expect(res.status).toBe(200);
      expect(res.body.tier).toBe('beta_unlimited');
    });
  });

  describe('tier 1: prepaid credits', () => {
    it('should deduct credits and authorize', async () => {
      // Admin check: not admin
      (db.from as any).mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: { is_platform_admin: false }, error: null }),
            in: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        }),
      });

      (db.rpc as any)
        .mockResolvedValueOnce({ data: 50, error: null }) // check_anchor_quota → not null = not beta
        .mockResolvedValueOnce({ data: { remaining: 100 }, error: null }) // check_unified_credits
        .mockResolvedValueOnce({ data: null, error: null }); // deduct_unified_credits

      const app = createApp('user-1', 'org-1');
      const res = await request(app).get('/api/v1/verify/test');
      expect(res.status).toBe(200);
      expect(res.body.tier).toBe('credits');
      expect(res.headers['x-credits-remaining']).toBe('99');
    });
  });

  describe('tier 3: 402 when no payment', () => {
    it('should return 402 when all tiers fail', async () => {
      // Not admin
      (db.from as any).mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            in: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        }),
      });

      (db.rpc as any)
        .mockResolvedValueOnce({ data: 50, error: null }) // not beta
        .mockResolvedValueOnce({ data: { remaining: 0 }, error: null }); // no credits

      const app = createApp('user-1', 'org-1');
      const res = await request(app).get('/api/v1/verify/test');
      expect(res.status).toBe(402);
      expect(res.body.error).toBe('payment_required');
      expect(res.body.tiers).toBeDefined();
      expect(res.body.tiers.credits).toBeDefined();
      expect(res.body.tiers.stripe).toBeDefined();
      expect(res.body.tiers.x402).toBeDefined();
    });
  });
});
