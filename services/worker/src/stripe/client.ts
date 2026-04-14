/**
 * Stripe Client
 *
 * Initializes the Stripe SDK for webhook signature verification,
 * checkout session creation, and billing portal sessions.
 * Uses the real Stripe client in production and the mock client
 * when USE_MOCKS=true.
 *
 * Per Constitution: Stripe keys are loaded from env vars (never hardcoded).
 *
 * @see P7-TS-02, P7-TS-03
 */

import Stripe from 'stripe';
import { config } from '../config.js';
import { mockStripeClient } from './mock.js';

/**
 * Real Stripe client — used for webhook signature verification
 * and any future Stripe API calls.
 */
export const stripe = new Stripe(config.stripeSecretKey, {
  apiVersion: '2026-03-25.dahlia',
  typescript: true,
});

/**
 * Verify a Stripe webhook signature and return the parsed event.
 *
 * - Production: uses stripe.webhooks.constructEvent() (cryptographic verification)
 * - Mock mode: parses JSON without verification (for tests)
 *
 * @throws Stripe.errors.StripeSignatureVerificationError if signature is invalid
 */
export function verifyWebhookSignature(
  payload: Buffer | string,
  signature: string,
): Stripe.Event {
  if (config.useMocks) {
    return mockStripeClient.constructEvent(
      typeof payload === 'string' ? payload : payload.toString(),
      signature,
      config.stripeWebhookSecret,
    ) as unknown as Stripe.Event;
  }

  return stripe.webhooks.constructEvent(
    payload,
    signature,
    config.stripeWebhookSecret,
  );
}

/**
 * Create a Stripe Checkout Session for a subscription plan.
 *
 * - Production: calls stripe.checkout.sessions.create()
 * - Mock mode: returns a mock session with a fake URL
 *
 * @param params.priceId - Stripe price ID from the plans table
 * @param params.userId - Arkova user ID (stored in session metadata for webhook handler)
 * @param params.customerEmail - User's email for Stripe customer creation
 * @param params.successUrl - Redirect URL on successful checkout
 * @param params.cancelUrl - Redirect URL on cancelled checkout
 */
export async function createCheckoutSession(params: {
  priceId: string;
  userId: string;
  customerEmail?: string;
  successUrl?: string;
  cancelUrl?: string;
  mode?: 'payment' | 'subscription';
  metadata?: Record<string, string>;
}): Promise<{ sessionId: string; url: string }> {
  if (config.useMocks) {
    const result = await mockStripeClient.createCheckoutSession({
      line_items: [{ price: params.priceId, quantity: 1 }],
      success_url: params.successUrl ?? '',
      cancel_url: params.cancelUrl ?? '',
      metadata: { user_id: params.userId, price_id: params.priceId },
    });
    return { sessionId: result.id, url: result.url ?? '' };
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: params.priceId, quantity: 1 }],
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    customer_email: params.customerEmail,
    metadata: { user_id: params.userId, price_id: params.priceId },
    subscription_data: {
      metadata: { user_id: params.userId, price_id: params.priceId },
    },
  });

  if (!session.url) {
    throw new Error('Stripe did not return a checkout URL');
  }

  return { sessionId: session.id, url: session.url };
}

/**
 * Create a Stripe Billing Portal Session for subscription management.
 *
 * - Production: calls stripe.billingPortal.sessions.create()
 * - Mock mode: returns a mock portal URL
 *
 * @param params.customerId - Stripe customer ID from the subscriptions table
 * @param params.returnUrl - URL to redirect back to after portal session
 */
export async function createBillingPortalSession(params: {
  customerId: string;
  returnUrl: string;
}): Promise<{ url: string }> {
  if (config.useMocks) {
    return mockStripeClient.createBillingPortalSession({
      customer: params.customerId,
      return_url: params.returnUrl,
    });
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: params.customerId,
    return_url: params.returnUrl,
  });

  return { url: session.url };
}
