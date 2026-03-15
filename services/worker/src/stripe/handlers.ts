/**
 * Stripe Webhook Handlers
 *
 * Handles Stripe webhook events with real DB operations.
 * Uses billing_events for idempotency, subscriptions table for state,
 * and audit_events for compliance logging.
 *
 * @see P7-TS-02, P7-TS-03
 */

import type Stripe from 'stripe';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

type StripeEvent = Stripe.Event;

// =========================================================================
// Idempotency — billing_events table
// =========================================================================

/**
 * Check if event was already processed using billing_events.stripe_event_id UNIQUE constraint.
 */
async function isEventProcessed(eventId: string): Promise<boolean> {
  const { data } = await db
    .from('billing_events')
    .select('id')
    .eq('stripe_event_id', eventId)
    .maybeSingle();

  return data !== null;
}

/**
 * Record event as processed in append-only billing_events table.
 */
async function recordEventProcessed(
  eventId: string,
  eventType: string,
  userId: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  const { error } = await db.from('billing_events').insert({
    stripe_event_id: eventId,
    event_type: eventType,
    user_id: userId,
    payload: payload as unknown as import('../types/database.types.js').Json,
  });

  if (error) {
    // UNIQUE violation means it was already recorded — not an error
    if (error.code === '23505') {
      logger.info({ eventId }, 'Event already recorded (duplicate)');
      return;
    }
    logger.error({ error, eventId }, 'Failed to record billing event');
    throw error;
  }
}

// =========================================================================
// Event Handlers
// =========================================================================

/**
 * Handle checkout.session.completed
 *
 * Upserts into subscriptions table (not profiles).
 * Looks up plan via stripe_price_id from the line items.
 */
export async function handleCheckoutComplete(event: StripeEvent): Promise<void> {
  const session = event.data.object as {
    id: string;
    customer: string;
    subscription: string;
    metadata?: { user_id?: string; price_id?: string };
  };

  logger.info({ sessionId: session.id }, 'Processing checkout completion');

  const userId = session.metadata?.user_id;
  if (!userId) {
    logger.error('No user_id in session metadata');
    return;
  }

  // Look up plan from the subscription's price
  // The price_id is stored in session metadata by createCheckoutSession
  let planId: string | null = null;
  const priceId = session.metadata?.price_id;

  if (priceId) {
    // Match the exact price_id from the checkout session to the plan
    const { data: matchedPlan } = await db
      .from('plans')
      .select('id')
      .eq('stripe_price_id', priceId)
      .maybeSingle();

    if (matchedPlan) {
      planId = matchedPlan.id;
    }
  }

  // Fallback: try all plans with stripe_price_id set
  if (!planId) {
    const { data: plans } = await db
      .from('plans')
      .select('id, stripe_price_id')
      .not('stripe_price_id', 'is', null);

    if (plans && plans.length === 1) {
      // Only use fallback if there's exactly one plan (unambiguous)
      planId = plans[0].id;
      logger.warn({ planId }, 'Used single-plan fallback for plan matching');
    } else {
      logger.error({ priceId, planCount: plans?.length }, 'Could not resolve plan from checkout session');
      throw new Error('Could not resolve plan from checkout session');
    }
  }

  // Upsert subscription (UNIQUE on user_id handles existing records)
  const { error: subError } = await db
    .from('subscriptions')
    .upsert(
      {
        user_id: userId,
        plan_id: planId,
        stripe_subscription_id: session.subscription,
        stripe_customer_id: session.customer,
        status: 'active',
      },
      { onConflict: 'user_id' },
    );

  if (subError) {
    logger.error({ subError, userId }, 'Failed to upsert subscription');
    throw subError;
  }

  // Log audit event
  await db.from('audit_events').insert({
    event_type: 'payment.subscription_created',
    event_category: 'ADMIN',
    actor_id: userId,
    details: `Subscription created: ${session.subscription}`,
  });

  logger.info({ userId, subscriptionId: session.subscription, planId }, 'Subscription activated');
}

/**
 * Handle customer.subscription.updated
 *
 * Updates subscription status, period dates, and detects plan changes.
 * When the Stripe price changes (via billing portal upgrade/downgrade),
 * resolves the new plan_id and logs an audit event.
 *
 * @see MVP-11
 */
export async function handleSubscriptionUpdated(event: StripeEvent): Promise<void> {
  const subscription = event.data.object as {
    id: string;
    customer: string;
    status: string;
    current_period_start: number;
    current_period_end: number;
    cancel_at_period_end: boolean;
    items?: { data: Array<{ price: { id: string } }> };
    metadata?: { user_id?: string };
  };

  logger.info(
    { subscriptionId: subscription.id, status: subscription.status },
    'Processing subscription update',
  );

  // Map Stripe status to our allowed statuses
  const statusMap: Record<string, string> = {
    active: 'active',
    past_due: 'past_due',
    canceled: 'canceled',
    trialing: 'trialing',
    paused: 'paused',
    unpaid: 'past_due',
    incomplete: 'trialing',
    incomplete_expired: 'canceled',
  };

  const mappedStatus = statusMap[subscription.status] ?? 'active';

  // Detect plan change: resolve plan_id from the current Stripe price
  let newPlanId: string | null = null;
  const currentPriceId = subscription.items?.data?.[0]?.price?.id;

  if (currentPriceId) {
    const { data: matchedPlan } = await db
      .from('plans')
      .select('id')
      .eq('stripe_price_id', currentPriceId)
      .maybeSingle();

    // Explicitly set plan_id even if null (price exists but no matching plan in DB)
    newPlanId = matchedPlan?.id ?? null;
  }

  // Get existing subscription to check for plan change and cancellation transition
  const { data: existingSub } = await db
    .from('subscriptions')
    .select('user_id, plan_id, cancel_at_period_end')
    .eq('stripe_subscription_id', subscription.id)
    .maybeSingle();

  // Build update payload
  const updatePayload: Record<string, unknown> = {
    status: mappedStatus,
    current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
    current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
    cancel_at_period_end: subscription.cancel_at_period_end,
  };

  // Always update plan_id when we resolved a price (even if null — clears stale value)
  if (currentPriceId) {
    updatePayload.plan_id = newPlanId;
  }

  const { error } = await db
    .from('subscriptions')
    .update(updatePayload)
    .eq('stripe_subscription_id', subscription.id);

  if (error) {
    logger.error({ error, subscriptionId: subscription.id }, 'Failed to update subscription');
    throw error;
  }

  // Log audit event if plan changed
  const planChanged = newPlanId && existingSub?.plan_id && newPlanId !== existingSub.plan_id;
  if (planChanged && existingSub.user_id) {
    await db.from('audit_events').insert({
      event_type: 'payment.plan_changed',
      event_category: 'ADMIN',
      actor_id: existingSub.user_id,
      details: `Plan changed from ${existingSub.plan_id} to ${newPlanId} (subscription: ${subscription.id})`,
    });

    logger.info(
      { subscriptionId: subscription.id, oldPlanId: existingSub.plan_id, newPlanId },
      'Plan change detected and applied',
    );
  }

  // Log audit event only on transition to cancel_at_period_end (false → true)
  const cancelTransition = subscription.cancel_at_period_end && !existingSub?.cancel_at_period_end;
  if (cancelTransition && existingSub?.user_id) {
    await db.from('audit_events').insert({
      event_type: 'payment.subscription_cancel_scheduled',
      event_category: 'ADMIN',
      actor_id: existingSub.user_id,
      details: `Subscription ${subscription.id} scheduled for cancellation at period end`,
    });
  }

  logger.info({ subscriptionId: subscription.id, status: mappedStatus, planChanged: !!planChanged }, 'Subscription updated');
}

/**
 * Handle customer.subscription.deleted
 *
 * Marks subscription as canceled and logs audit event.
 */
export async function handleSubscriptionDeleted(event: StripeEvent): Promise<void> {
  const subscription = event.data.object as {
    id: string;
    customer: string;
    metadata?: { user_id?: string };
  };

  logger.info({ subscriptionId: subscription.id }, 'Processing subscription deletion');

  // Get the subscription to find user_id for audit log
  const { data: existingSub } = await db
    .from('subscriptions')
    .select('user_id')
    .eq('stripe_subscription_id', subscription.id)
    .maybeSingle();

  const { error } = await db
    .from('subscriptions')
    .update({ status: 'canceled' })
    .eq('stripe_subscription_id', subscription.id);

  if (error) {
    logger.error({ error, subscriptionId: subscription.id }, 'Failed to cancel subscription');
    throw error;
  }

  // Log audit event if we found the user
  if (existingSub?.user_id) {
    await db.from('audit_events').insert({
      event_type: 'payment.subscription_canceled',
      event_category: 'ADMIN',
      actor_id: existingSub.user_id,
      details: `Subscription canceled: ${subscription.id}`,
    });
  }

  logger.info({ subscriptionId: subscription.id }, 'Subscription canceled');
}

/**
 * Handle invoice.payment_failed
 *
 * Logs the failure and marks subscription as past_due.
 */
export async function handlePaymentFailed(event: StripeEvent): Promise<void> {
  const invoice = event.data.object as {
    id: string;
    customer: string;
    subscription: string;
  };

  logger.warn({ invoiceId: invoice.id, subscription: invoice.subscription }, 'Payment failed');

  if (invoice.subscription) {
    const { error } = await db
      .from('subscriptions')
      .update({ status: 'past_due' })
      .eq('stripe_subscription_id', invoice.subscription);

    if (error) {
      logger.error({ error, invoiceId: invoice.id }, 'Failed to update subscription to past_due');
      throw error;
    }
  }

  // Get user for audit log
  if (invoice.subscription) {
    const { data: sub } = await db
      .from('subscriptions')
      .select('user_id')
      .eq('stripe_subscription_id', invoice.subscription)
      .maybeSingle();

    if (sub?.user_id) {
      await db.from('audit_events').insert({
        event_type: 'payment.failed',
        event_category: 'ADMIN',
        actor_id: sub.user_id,
        details: `Payment failed for invoice: ${invoice.id}`,
      });
    }
  }
}

// =========================================================================
// Main Webhook Router
// =========================================================================

/**
 * Main webhook handler — routes events, checks idempotency, records processing.
 */
export async function handleStripeWebhook(event: StripeEvent): Promise<void> {
  // Check idempotency
  if (await isEventProcessed(event.id)) {
    logger.info({ eventId: event.id }, 'Event already processed');
    return;
  }

  // Extract user_id from event metadata if available
  let userId: string | null = null;
  const obj = event.data.object as Record<string, unknown>;
  const metadata = obj.metadata as Record<string, string> | undefined;
  if (metadata?.user_id) {
    userId = metadata.user_id;
  }

  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutComplete(event);
      break;
    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(event);
      break;
    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event);
      break;
    case 'invoice.payment_failed':
      await handlePaymentFailed(event);
      break;
    default:
      logger.info({ eventType: event.type }, 'Unhandled event type');
  }

  // Record as processed in billing_events (idempotency + audit)
  await recordEventProcessed(event.id, event.type, userId, obj as Record<string, unknown>);
}
