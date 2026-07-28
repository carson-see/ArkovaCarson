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
import { paymentTierRouter, PaymentResolution, stripeMeteredIdempotencyKey } from './paymentTierRouter.js';

type PayReq = Request & { userId?: string; orgId?: string; paymentResolution?: PaymentResolution };

function createApp(userId?: string, orgId?: string) {
  const app = express();
  app.use(express.json());

  // Simulate auth middleware
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (userId) (req as PayReq).userId = userId;
    if (orgId) (req as PayReq).orgId = orgId;
    next();
  });

  app.use(paymentTierRouter());

  app.get('/api/v1/verify/:id', (req: Request, res: Response) => {
    res.json({ ok: true, tier: (req as PayReq).paymentResolution?.tier });
  });

  app.post('/api/v1/ai/extract', (req: Request, res: Response) => {
    res.json({ ok: true, tier: (req as PayReq).paymentResolution?.tier });
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
      (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
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
      (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: { is_platform_admin: false }, error: null }),
          }),
        }),
      });
      (db.rpc as ReturnType<typeof vi.fn>)
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
      (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: { is_platform_admin: false }, error: null }),
            in: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        }),
      });

      (db.rpc as ReturnType<typeof vi.fn>)
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

  describe('tier 2: stripe metered billing — SCRUM-2971 idempotency', () => {
    function mockDbForStripeMetered(billingEventsInsert: ReturnType<typeof vi.fn>) {
      (db.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
        if (table === 'profiles') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: { is_platform_admin: false }, error: null }),
              }),
            }),
          };
        }
        if (table === 'subscriptions') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { id: 's-1', stripe_subscription_id: 'sub_1', status: 'active', plan_id: 'plan-metered' },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'billing_events') {
          return { insert: billingEventsInsert };
        }
        throw new Error(`unexpected table query in test: ${table}`);
      });
    }

    /** Not beta unlimited, zero credits — falls through to tier 2. */
    function mockNotBetaNoCredits() {
      (db.rpc as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ data: 50, error: null }) // check_anchor_quota → not beta
        .mockResolvedValueOnce({ data: { remaining: 0 }, error: null }); // check_unified_credits → none
    }

    it('records a stripe-metered billing_events row keyed off the Idempotency-Key header', async () => {
      const billingEventsInsert = vi.fn().mockResolvedValue({ error: null });
      mockDbForStripeMetered(billingEventsInsert);
      mockNotBetaNoCredits();

      const app = createApp('user-1', 'org-1');
      const res = await request(app)
        .get('/api/v1/verify/test')
        .set('Idempotency-Key', 'client-req-1');

      expect(res.status).toBe(200);
      expect(res.body.tier).toBe('stripe_metered');
      expect(billingEventsInsert).toHaveBeenCalledTimes(1);
      expect(billingEventsInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          org_id: 'org-1',
          user_id: 'user-1',
          event_type: 'api_metered_usage',
          idempotency_key: stripeMeteredIdempotencyKey('org-1', 'user-1', 'client-req-1'),
        }),
      );
    });

    it('retry of the same call (same Idempotency-Key) does not fail the request even when the DB rejects the duplicate insert (23505)', async () => {
      const billingEventsInsert = vi.fn().mockResolvedValue({
        error: { code: '23505', message: 'duplicate key value violates unique constraint' },
      });
      mockDbForStripeMetered(billingEventsInsert);
      mockNotBetaNoCredits();

      const app = createApp('user-1', 'org-1');
      const res = await request(app)
        .get('/api/v1/verify/test')
        .set('Idempotency-Key', 'client-req-retry');

      // Billing dedup must never block usage — the request still authorizes.
      expect(res.status).toBe(200);
      expect(res.body.tier).toBe('stripe_metered');
    });

    it('two distinct calls (different Idempotency-Key) produce distinct idempotency_key values — not collapsed', async () => {
      const billingEventsInsert = vi.fn().mockResolvedValue({ error: null });
      mockDbForStripeMetered(billingEventsInsert);
      const app = createApp('user-1', 'org-1');

      mockNotBetaNoCredits();
      await request(app).get('/api/v1/verify/test').set('Idempotency-Key', 'req-A');

      mockNotBetaNoCredits();
      await request(app).get('/api/v1/verify/test').set('Idempotency-Key', 'req-B');

      expect(billingEventsInsert).toHaveBeenCalledTimes(2);
      const keys = billingEventsInsert.mock.calls.map(
        (call) => (call[0] as { idempotency_key: string }).idempotency_key,
      );
      expect(new Set(keys).size).toBe(2);
    });

    it('falls back to a generated request id (no Idempotency-Key header) without throwing', async () => {
      const billingEventsInsert = vi.fn().mockResolvedValue({ error: null });
      mockDbForStripeMetered(billingEventsInsert);
      mockNotBetaNoCredits();

      const app = createApp('user-1', 'org-1');
      const res = await request(app).get('/api/v1/verify/test');

      expect(res.status).toBe(200);
      expect(res.body.tier).toBe('stripe_metered');
      expect(billingEventsInsert).toHaveBeenCalledWith(
        expect.objectContaining({ idempotency_key: expect.any(String) }),
      );
    });
  });

  describe('tier 3: 402 when no payment', () => {
    it('should return 402 when all tiers fail', async () => {
      // Not admin
      (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            in: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        }),
      });

      (db.rpc as ReturnType<typeof vi.fn>)
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
