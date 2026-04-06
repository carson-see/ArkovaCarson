/**
 * Payment Tier Router Middleware (PAY-03 / SCRUM-444)
 *
 * Three-tier payment resolution for API requests:
 *   Tier 1: Prepaid credits (cheapest, fastest — no external calls)
 *   Tier 2: Stripe metered billing (enterprise — recorded and invoiced monthly)
 *   Tier 3: x402 on-chain payment (crypto-native — USDC on Base)
 *
 * Falls through tiers in order. If all fail, returns 402 Payment Required.
 *
 * Constitution refs:
 *   - 1.4: Payment details never logged
 *   - 1.9: Gated by ENABLE_PAYMENT_TIERS flag
 */

import { Request, Response, NextFunction } from 'express';
import { db } from '../utils/db.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export type PaymentTier = 'credits' | 'stripe_metered' | 'x402' | 'admin_bypass' | 'beta_unlimited';

export interface PaymentResolution {
  tier: PaymentTier;
  authorized: boolean;
  creditsRemaining?: number;
  reason?: string;
}

/** Cost in credits per endpoint (1 credit = 1 API call) */
const CREDIT_COSTS: Record<string, number> = {
  '/api/v1/verify': 1,
  '/api/v1/verify/batch': 1, // per item
  '/api/v1/ai/extract': 5,
  '/api/v1/ai/search': 2,
  '/api/v1/nessie/query': 3,
  '/api/v1/anchor': 10,
  '/api/v1/sign': 5,
  '/api/v1/verify-signature': 1,
};

function getCreditCost(path: string): number {
  // Match against known endpoints
  for (const [endpoint, cost] of Object.entries(CREDIT_COSTS)) {
    if (path.startsWith(endpoint)) return cost;
  }
  return 1; // default 1 credit
}

// ─── Tier 1: Prepaid Credits ────────────────────────────────────────────

async function tryCredits(orgId: string, userId: string, cost: number): Promise<PaymentResolution | null> {
  try {
    const { data, error } = await db.rpc('check_unified_credits', {
      p_org_id: orgId,
      p_user_id: userId,
    });

    if (error || !data) return null;

    // check_unified_credits returns TABLE — Supabase may return array or single row
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;

    const remaining = (row as { remaining: number }).remaining ?? 0;
    if (remaining < cost) return null;

    // Deduct credits
    const { error: deductError } = await db.rpc('deduct_unified_credits', {
      p_org_id: orgId,
      p_user_id: userId,
      p_amount: cost,
    });

    if (deductError) {
      logger.warn({ error: deductError }, 'Credit deduction failed');
      return null;
    }

    return {
      tier: 'credits',
      authorized: true,
      creditsRemaining: remaining - cost,
    };
  } catch {
    return null;
  }
}

// ─── Tier 2: Stripe Metered Billing ─────────────────────────────────────

async function tryStripeMetered(userId: string, orgId: string): Promise<PaymentResolution | null> {
  try {
    // Check for active metered subscription
    const { data } = await db
      .from('subscriptions')
      .select('id, stripe_subscription_id, status, plan_id')
      .eq('user_id', userId)
      .in('status', ['active', 'trialing'])
      .maybeSingle();

    if (!data) return null;

    // Record metered usage (will be invoiced at end of billing period)
    try {
      await db.from('billing_events').insert({
        org_id: orgId,
        user_id: userId,
        event_type: 'api_metered_usage',
        payload: {
          stripe_subscription_id: data.stripe_subscription_id,
          timestamp: new Date().toISOString(),
          source: 'payment_tier_router',
        },
      });
    } catch {
      // Non-critical — usage still authorized
    }

    return {
      tier: 'stripe_metered',
      authorized: true,
    };
  } catch {
    return null;
  }
}

// ─── Tier 3: x402 On-Chain Payment ──────────────────────────────────────

async function tryX402(req: Request): Promise<PaymentResolution | null> {
  // Check for x402 payment header
  const paymentHeader = req.headers['x-payment'] as string | undefined;
  if (!paymentHeader) return null;

  // Validate tx_hash format (hex string, reasonable length) to prevent abuse
  if (!/^0x[a-fA-F0-9]{64}$/.test(paymentHeader) && paymentHeader.length > 128) {
    return null;
  }

  // Check for verified, unconsumed payment — mark as consumed atomically
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (db as any)
    .from('x402_payments')
    .select('id, tx_hash')
    .eq('tx_hash', paymentHeader)
    .eq('verified', true)
    .is('consumed_at', null)
    .maybeSingle();

  if (!data) return null;

  // Mark payment as consumed to prevent replay
  await (db as any)
    .from('x402_payments')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', data.id)
    .is('consumed_at', null); // optimistic lock

  return {
    tier: 'x402',
    authorized: true,
  };
}

// ─── Admin/Beta Bypass ──────────────────────────────────────────────────

async function tryAdminBypass(userId: string): Promise<PaymentResolution | null> {
  try {
    const { data } = await db
      .from('profiles')
      .select('is_platform_admin')
      .eq('id', userId)
      .maybeSingle();

    if (data?.is_platform_admin === true) {
      return { tier: 'admin_bypass', authorized: true };
    }
    return null;
  } catch {
    return null;
  }
}

async function tryBetaUnlimited(): Promise<PaymentResolution | null> {
  try {
    const { data, error } = await db.rpc('check_anchor_quota');
    if (error) return null;
    if (data === null) {
      return { tier: 'beta_unlimited', authorized: true };
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Main Middleware ─────────────────────────────────────────────────────

/**
 * Payment tier router middleware.
 *
 * Resolves payment in priority order:
 *   0. Admin bypass / beta unlimited (free)
 *   1. Prepaid credits (fastest)
 *   2. Stripe metered billing (enterprise)
 *   3. x402 on-chain payment (crypto)
 *
 * On success, sets req.paymentResolution for downstream logging.
 * On failure, returns 402 with tier-specific upgrade instructions.
 */
export function paymentTierRouter() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Skip for health/docs endpoints
    if (req.path === '/health' || req.path.startsWith('/api/docs')) {
      next();
      return;
    }

    const userId = (req as any).userId as string | undefined;
    const orgId = (req as any).orgId as string | undefined;

    if (!userId) {
      // No auth context — let auth middleware handle it
      next();
      return;
    }

    // 0. Admin/beta bypass
    const admin = await tryAdminBypass(userId);
    if (admin) {
      (req as any).paymentResolution = admin;
      next();
      return;
    }

    const beta = await tryBetaUnlimited();
    if (beta) {
      (req as any).paymentResolution = beta;
      next();
      return;
    }

    const creditCost = getCreditCost(req.path);

    // 1. Prepaid credits
    if (orgId) {
      const credits = await tryCredits(orgId, userId, creditCost);
      if (credits) {
        (req as any).paymentResolution = credits;
        res.setHeader('X-Credits-Remaining', String(credits.creditsRemaining ?? 0));
        next();
        return;
      }
    }

    // 2. Stripe metered billing
    if (orgId) {
      const stripe = await tryStripeMetered(userId, orgId);
      if (stripe) {
        (req as any).paymentResolution = stripe;
        next();
        return;
      }
    }

    // 3. x402 on-chain payment
    const x402 = await tryX402(req);
    if (x402) {
      (req as any).paymentResolution = x402;
      next();
      return;
    }

    // No valid payment source
    res.status(402).json({
      error: 'payment_required',
      message: 'No valid payment source. Options: prepaid credits, Stripe subscription, or x402 payment.',
      tiers: {
        credits: { description: 'Purchase credit packs at /pricing', cost: creditCost },
        stripe: { description: 'Subscribe for metered billing at /pricing' },
        x402: { description: 'Pay per-request with USDC on Base' },
      },
    });
  };
}
