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

import crypto from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { getCorrelationId } from '../utils/correlationId.js';
import { captureCreditRpcFailureAlert } from '../utils/sentry.js';

export type PaymentTier = 'credits' | 'stripe_metered' | 'x402' | 'admin_bypass' | 'beta_unlimited';

export interface PaymentResolution {
  tier: PaymentTier;
  authorized: boolean;
  creditsRemaining?: number;
  reason?: string;
}

interface PaymentRequest extends Request {
  userId?: string;
  orgId?: string;
  paymentResolution?: PaymentResolution;
}

interface UntypedX402QueryBuilder {
  select(columns: string): UntypedX402QueryBuilder;
  update(row: Record<string, unknown>): UntypedX402QueryBuilder;
  eq(col: string, val: unknown): UntypedX402QueryBuilder;
  is(col: string, val: unknown): UntypedX402QueryBuilder;
  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: unknown }>;
  then: Promise<{ data: unknown; error: unknown }>['then'];
}

interface UntypedX402Client {
  from(table: string): UntypedX402QueryBuilder;
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
      // Fail OPEN by construction: returning null here makes the caller fall
      // through to the next payment tier (Stripe metered billing) even though
      // the org already had credits — the customer gets CHARGED instead of a
      // credit they already paid for being consumed. Behavior intentionally
      // unchanged (product decision); this alert makes the leak visible.
      logger.warn({ error: deductError }, 'Credit deduction failed');
      captureCreditRpcFailureAlert({
        rpc: 'deduct_unified_credits',
        operation: 'paymentTierRouter.tryCredits',
        failMode: 'open',
        error: new Error('deduct_unified_credits failed — falling through to Stripe metered billing'),
        orgId,
        userId,
        extra: { amount: cost },
      });
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

/**
 * KNOWN UNDER-BILLING VECTOR (SCRUM-2971 code review follow-up) — READ
 * BEFORE MOUNTING `paymentTierRouter()` IN index.ts.
 *
 * `stripeMeteredRequestId()` below trusts the client-supplied
 * `Idempotency-Key` header as the SOLE input to the Tier-2 billing_events
 * idempotency key (`stripeMeteredIdempotencyKey`). A subscriber who sends
 * the SAME `Idempotency-Key` value on every metered call — not just on
 * genuine retries of one call — causes every insert after the first to
 * collide on `UNIQUE(idempotency_key)` (23505 in `tryStripeMetered`),
 * which is swallowed as an idempotent no-op. The request is still
 * authorized (usage served), but at most ONE `billing_events` row is EVER
 * written for that org+user+key: silent, effectively unbounded
 * under-billing, not merely a missed audit row —
 * `reportMeteredUsageToStripe()` sums these rows to invoice Stripe.
 *
 * This is currently UNREACHABLE: `paymentTierRouter` is not imported or
 * mounted anywhere in `services/worker/src/index.ts` (verified via
 * `grep -rl paymentTierRouter services/worker/src` — only this file, its
 * own test, `middleware/agents.md`, and the `express.d.ts` type
 * augmentation reference it). The moment that changes, this vector goes
 * live.
 *
 * `paymentTierRouter.mount-guard.test.ts` enforces this mechanically: it
 * fails CI the instant `paymentTierRouter` is referenced from
 * `index.ts` UNLESS `STRIPE_METERED_UNDER_BILLING_RISK_ACKED` below has
 * been explicitly flipped to `true`. Flipping it requires EITHER (a)
 * rebinding the idempotency key to something other than a raw,
 * fully-client-controlled header — e.g. a server-derived per-request-
 * window component so a replayed header can only collapse calls within
 * one bounded window instead of unboundedly many — OR (b) an explicit,
 * dated, named sign-off recorded in this comment that the risk is
 * accepted for launch. Do not flip the flag to unblock mounting without
 * doing one of those two things; that defeats the guard's purpose.
 */
export const STRIPE_METERED_UNDER_BILLING_RISK_ACKED = false;

/**
 * SCRUM-2971: deterministic idempotency key for a Stripe-metered billing_events
 * row. Built from (org_id, user_id, requestId) only — a retry that resolves
 * to the SAME requestId always hashes to the SAME key and collapses onto the
 * row from the first attempt; a different request always gets its own row.
 */
export function stripeMeteredIdempotencyKey(orgId: string, userId: string, requestId: string): string {
  const material = `api_metered_usage:${orgId}:${userId}:${requestId}`;
  return crypto.createHash('sha256').update(material).digest('hex');
}

/**
 * SCRUM-2971: request-scoped stable id for this specific API call, used to
 * dedupe metered billing_events inserts on retry. Priority order:
 *   1. `Idempotency-Key` header — the existing Stripe-style caller contract
 *      already documented in `middleware/idempotency.ts` (DX-4); if the
 *      client is retry-aware it resends the same value.
 *   2. Correlation ID (`X-Request-Id` / `X-Correlation-Id`, see
 *      `utils/correlationId.ts`) — resent by retry-aware HTTP clients that
 *      preserve headers across a retry of the same logical request.
 *   3. A fresh random id as a last resort. A header-less retry with
 *      neither identifier present cannot be deduped — that is a known,
 *      documented limitation, and strictly no worse than the previous
 *      fully-unprotected (NULL idempotency_key) state.
 */
function stripeMeteredRequestId(req: Request): string {
  const headerKey = req.headers['idempotency-key'];
  if (typeof headerKey === 'string' && headerKey.length > 0) return headerKey;
  const correlationId = getCorrelationId();
  if (correlationId) return correlationId;
  return crypto.randomUUID();
}

async function tryStripeMetered(userId: string, orgId: string, req: Request): Promise<PaymentResolution | null> {
  try {
    // Check for active metered subscription
    const { data } = await db
      .from('subscriptions')
      .select('id, stripe_subscription_id, status, plan_id')
      .eq('user_id', userId)
      .in('status', ['active', 'trialing'])
      .maybeSingle();

    if (!data) return null;

    // Record metered usage (will be invoiced at end of billing period).
    // Idempotent: a retry that reuses the same request-scoped id (see
    // stripeMeteredRequestId) collapses onto the row already inserted
    // instead of double-recording usage (= double Stripe billing).
    try {
      const requestId = stripeMeteredRequestId(req);
      const { error: insertError } = await db.from('billing_events').insert({
        org_id: orgId,
        user_id: userId,
        event_type: 'api_metered_usage',
        idempotency_key: stripeMeteredIdempotencyKey(orgId, userId, requestId),
        payload: {
          stripe_subscription_id: data.stripe_subscription_id,
          timestamp: new Date().toISOString(),
          source: 'payment_tier_router',
        },
      });
      if (insertError && (insertError as { code?: string }).code !== '23505') {
        // Non-critical — usage still authorized. 23505 (already recorded,
        // an idempotent retry) isn't even worth a warn; anything else is.
        logger.warn({ error: insertError, orgId, userId }, 'Failed to record stripe-metered billing event');
      }
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

  // Validate tx_hash format — must be 0x-prefixed 64-char hex; reject anything else
  if (!/^0x[a-fA-F0-9]{64}$/.test(paymentHeader)) {
    return null;
  }

  // Check for verified, unconsumed payment — mark as consumed atomically
  const { data } = await (db as unknown as UntypedX402Client)
    .from('x402_payments')
    .select('id, tx_hash')
    .eq('tx_hash', paymentHeader)
    .eq('verified', true)
    .is('consumed_at', null)
    .maybeSingle();

  if (!data) return null;

  // Mark payment as consumed to prevent replay
  await (db as unknown as UntypedX402Client)
    .from('x402_payments')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', (data as { id: string }).id)
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

    const payReq = req as PaymentRequest;
    const userId = payReq.userId;
    const orgId = payReq.orgId;

    if (!userId) {
      // No auth context — let auth middleware handle it
      next();
      return;
    }

    // 0. Admin/beta bypass
    const admin = await tryAdminBypass(userId);
    if (admin) {
      payReq.paymentResolution = admin;
      next();
      return;
    }

    const beta = await tryBetaUnlimited();
    if (beta) {
      payReq.paymentResolution = beta;
      next();
      return;
    }

    const creditCost = getCreditCost(req.path);

    // 1. Prepaid credits
    if (orgId) {
      const credits = await tryCredits(orgId, userId, creditCost);
      if (credits) {
        payReq.paymentResolution = credits;
        res.setHeader('X-Credits-Remaining', String(credits.creditsRemaining ?? 0));
        next();
        return;
      }
    }

    // 2. Stripe metered billing
    if (orgId) {
      const stripe = await tryStripeMetered(userId, orgId, req);
      if (stripe) {
        payReq.paymentResolution = stripe;
        next();
        return;
      }
    }

    // 3. x402 on-chain payment
    const x402 = await tryX402(req);
    if (x402) {
      payReq.paymentResolution = x402;
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
