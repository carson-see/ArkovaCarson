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
import { config } from '../config.js';
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
      successUrl: `${config.frontendUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${config.frontendUrl}/billing/cancel`,
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
      returnUrl: `${config.frontendUrl}/settings`,
    });

    logger.info({ userId }, 'Billing portal session created');
    res.json({ url: portal.url });
  } catch (error) {
    logger.error({ error, userId }, 'Failed to create billing portal session');
    sendError(res, 500, 'internal_error', 'Failed to create billing portal session');
  }
});
