/**
 * Billing Routes (P7-TS-02)
 *
 * Handles Stripe Checkout and Billing Portal sessions.
 * Extracted from index.ts as part of ARCH-1 refactor.
 *
 * DX-3: Consistent error format: { error: { code, message } }
 */

import { Router } from 'express';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { rateLimiters } from '../utils/rateLimit.js';
import { createCheckoutSession, createBillingPortalSession } from '../stripe/client.js';
import {
  BILLING_SUCCESS_URL,
  BILLING_CANCEL_URL,
  BILLING_PORTAL_RETURN_URL,
} from '../lib/urls.js';
import { corsMiddleware, extractAuthUserId } from './middleware.js';

export const billingRouter = Router();

// CORS for all billing routes
billingRouter.use(corsMiddleware);

/** DX-3: Standardized error response helper */
function sendError(res: import('express').Response, statusCode: number, code: string, message: string) {
  res.status(statusCode).json({ error: { code, message } });
}

/**
 * POST /api/checkout/session
 * Creates a Stripe Checkout Session for subscription purchase.
 */
billingRouter.post('/checkout/session', rateLimiters.checkout, async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) {
    sendError(res, 401, 'authentication_required', 'Authentication required');
    return;
  }

  const { planId } = req.body as { planId?: string };
  if (!planId) {
    sendError(res, 400, 'invalid_request', 'planId is required');
    return;
  }

  try {
    const { data: plan, error: planError } = await db
      .from('plans')
      .select('id, name, stripe_price_id, price_cents')
      .eq('id', planId)
      .eq('is_active', true)
      .single();

    if (planError || !plan) {
      logger.warn({ planId, planError }, 'Plan not found');
      sendError(res, 404, 'not_found', 'Plan not found');
      return;
    }

    if (!plan.stripe_price_id) {
      logger.warn({ planId }, 'Plan has no Stripe price ID configured');
      sendError(res, 400, 'invalid_request', 'Plan is not available for online checkout');
      return;
    }

    const { data: profile, error: profileError } = await db
      .from('profiles')
      .select('email')
      .eq('id', userId)
      .single();

    if (profileError || !profile?.email) {
      logger.warn({ userId, profileError }, 'User profile or email not found');
      sendError(res, 404, 'not_found', 'User profile not found');
      return;
    }

    const { data: existingSub } = await db
      .from('subscriptions')
      .select('id, status')
      .eq('user_id', userId)
      .in('status', ['active', 'trialing'])
      .maybeSingle();

    if (existingSub) {
      sendError(res, 409, 'conflict', 'User already has an active subscription. Use the billing portal to change plans.');
      return;
    }

    const session = await createCheckoutSession({
      priceId: plan.stripe_price_id,
      userId,
      customerEmail: profile.email,
      successUrl: BILLING_SUCCESS_URL,
      cancelUrl: BILLING_CANCEL_URL,
      metadata: { plan_id: plan.id },
    });

    logger.info({ userId, planId, sessionId: session.sessionId }, 'Checkout session created');
    res.json({ sessionId: session.sessionId, url: session.url });
  } catch (error) {
    logger.error({ error, planId, userId }, 'Failed to create checkout session');
    sendError(res, 500, 'internal_error', 'Failed to create checkout session');
  }
});

/**
 * POST /api/billing/portal
 * Creates a Stripe Billing Portal Session for subscription management.
 */
billingRouter.post('/billing/portal', rateLimiters.checkout, async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) {
    sendError(res, 401, 'authentication_required', 'Authentication required');
    return;
  }

  try {
    const { data: subscription, error: subError } = await db
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .single();

    if (subError || !subscription?.stripe_customer_id) {
      logger.warn({ userId, subError }, 'No subscription found for user');
      sendError(res, 404, 'not_found', 'No active subscription found');
      return;
    }

    const portal = await createBillingPortalSession({
      customerId: subscription.stripe_customer_id,
      returnUrl: BILLING_PORTAL_RETURN_URL,
    });

    logger.info({ userId }, 'Billing portal session created');
    res.json({ url: portal.url });
  } catch (error) {
    logger.error({ error, userId }, 'Failed to create billing portal session');
    sendError(res, 500, 'internal_error', 'Failed to create billing portal session');
  }
});

/** Allowed subscription statuses in the public BillingInfo contract. */
const SUBSCRIPTION_STATUSES = new Set<string>(['active', 'trialing', 'past_due', 'canceled']);
type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'canceled';

function normalizeStatus(raw: string | null | undefined): SubscriptionStatus {
  return raw && SUBSCRIPTION_STATUSES.has(raw) ? (raw as SubscriptionStatus) : 'canceled';
}

/**
 * Best-effort count of the caller's anchors in the current billing period.
 *
 * Org subscriptions scope by `org_id`; individual/free subscriptions (no
 * `org_id`) scope by `user_id` — matching how the frontend `useEntitlements`
 * hook counts usage (SCRUM-2210 review). Uses `count: 'estimated'` (planner
 * estimate) deliberately — an exact count is banned on the large `anchors`
 * table (R0-8 / SCRUM-1254: exact counts full-scan it and hit the 60s
 * PostgREST timeout). Never throws: a slow or failing count returns 0 so it
 * can never brick the billing page.
 */
async function countAnchorUsage(
  scope: { orgId: string | null; userId: string; periodStart: string | null },
): Promise<number> {
  try {
    let usageQuery = db.from('anchors').select('*', { count: 'estimated', head: true });
    usageQuery = scope.orgId
      ? usageQuery.eq('org_id', scope.orgId)
      : usageQuery.eq('user_id', scope.userId);
    if (scope.periodStart) {
      usageQuery = usageQuery.gte('created_at', scope.periodStart);
    }
    const { count, error } = await usageQuery;
    if (error) {
      logger.warn({ error, userId: scope.userId }, 'billing/status: usage count failed (non-fatal)');
      return 0;
    }
    return typeof count === 'number' ? count : 0;
  } catch (err) {
    logger.warn({ error: err, userId: scope.userId }, 'billing/status: usage count threw (non-fatal)');
    return 0;
  }
}

/**
 * GET /api/billing/status
 *
 * Returns the caller's current BillingInfo (subscription status + plan + usage),
 * matching the shape `src/components/billing/BillingOverview.tsx` consumes.
 *
 * SCRUM-2210: the frontend BillingPage has always fetched this endpoint, but it
 * was never implemented in the worker (`billingRouter` only had /checkout/session
 * and /billing/portal) → 404 → the billing page could not load. This handler fills
 * that contract.
 *
 * Resilience (the lesson from SCRUM-1983 / SCRUM-2213): the endpoint returns 200
 * with a usable BillingInfo on every normal path — a caller with no subscription
 * gets a free-tier default, and the usage count is best-effort (recordsUsed falls
 * back to 0 if the count errors or times out) so a downstream query failure can't
 * brick the page. The only 500 is a hard failure of the primary subscription
 * lookup itself.
 */
export async function handleBillingStatus(
  req: import('express').Request,
  res: import('express').Response,
): Promise<void> {
  const userId = await extractAuthUserId(req);
  if (!userId) {
    sendError(res, 401, 'authentication_required', 'Authentication required');
    return;
  }

  try {
    const { data: sub, error: subError } = await db
      .from('subscriptions')
      .select('status, plan_id, org_id, current_period_start, current_period_end')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (subError) {
      logger.error({ error: subError, userId }, 'billing/status: subscription lookup failed');
      sendError(res, 500, 'internal_error', 'Failed to load billing status');
      return;
    }

    // No subscription → safe free-tier default so the page always renders.
    if (!sub) {
      res.json({
        status: 'canceled',
        plan: { name: 'Free', recordsIncluded: 0 },
        usage: { recordsUsed: 0, recordsLimit: null },
        billing: { status: 'canceled' },
      });
      return;
    }

    const { data: plan } = await db
      .from('plans')
      .select('name, price_cents, billing_period, records_per_month')
      .eq('id', sub.plan_id)
      .maybeSingle();

    const recordsLimit =
      plan?.records_per_month && plan.records_per_month > 0 ? plan.records_per_month : null;

    // Best-effort usage count — scoped by org_id, or by user_id for individual
    // (non-org) subscriptions so the meter is correct on individual/free plans.
    const recordsUsed = await countAnchorUsage({
      orgId: sub.org_id,
      userId,
      periodStart: sub.current_period_start,
    });

    const status = normalizeStatus(sub.status);

    res.json({
      status,
      plan: {
        name: plan?.name ?? 'Unknown',
        price: plan ? plan.price_cents / 100 : undefined,
        period: plan ? (plan.billing_period === 'year' ? 'year' : 'month') : undefined,
        recordsIncluded: recordsLimit ?? 'unlimited',
      },
      usage: {
        recordsUsed,
        recordsLimit,
        percentUsed:
          recordsLimit && recordsLimit > 0
            ? Math.min(100, Math.round((recordsUsed / recordsLimit) * 100))
            : undefined,
      },
      billing: {
        status,
        currentPeriodEnd: sub.current_period_end ?? undefined,
        nextBillingDate: sub.current_period_end ?? undefined,
      },
    });
  } catch (error) {
    logger.error({ error, userId }, 'Failed to load billing status');
    sendError(res, 500, 'internal_error', 'Failed to load billing status');
  }
}

billingRouter.get('/billing/status', rateLimiters.api, handleBillingStatus);
