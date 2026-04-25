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
import { callRpc } from '../utils/rpc.js';

type StripeEvent = Stripe.Event;

const PROFILE_TIER_BY_PLAN_ID: Record<string, string> = {
  free: 'free',
  individual_verified_monthly: 'verified_individual',
  individual_verified_annual: 'verified_individual',
  org_free: 'org_free',
  small_business: 'small_business',
  medium_business: 'medium_business',
  enterprise: 'enterprise',
};

type StripeReference = string | { id?: string | null } | null | undefined;

interface PaymentGraceTarget {
  userId: string | null;
  orgId: string | null;
}

function stripeReferenceId(ref: StripeReference): string | null {
  if (typeof ref === 'string') return ref;
  return ref?.id ?? null;
}

async function resolvePaymentGraceTarget(
  stripeSubscriptionId: string,
): Promise<PaymentGraceTarget> {
  const { data: subscription, error } = await db
    .from('subscriptions')
    .select('user_id, org_id')
    .eq('stripe_subscription_id', stripeSubscriptionId)
    .maybeSingle();

  if (error) {
    logger.error({ error, stripeSubscriptionId }, 'Failed to resolve subscription for payment grace');
    throw error;
  }

  const userId = subscription?.user_id ?? null;
  let orgId = subscription?.org_id ?? null;

  if (!orgId && userId) {
    const { data: profile, error: profileError } = await db
      .from('profiles')
      .select('org_id')
      .eq('id', userId)
      .maybeSingle();

    if (profileError) {
      logger.error({ error: profileError, userId, stripeSubscriptionId }, 'Failed to resolve profile org for payment grace');
      throw profileError;
    }

    orgId = profile?.org_id ?? null;
  }

  if (!orgId) {
    logger.warn(
      { stripeSubscriptionId, userId },
      'Payment grace RPC skipped because no organization was found',
    );
  }

  return { userId, orgId };
}

async function callPaymentGraceRpc(
  rpcName: 'start_payment_grace' | 'clear_payment_grace',
  orgId: string,
  context: { invoiceId: string; stripeSubscriptionId: string },
): Promise<void> {
  const { error } = await callRpc<Record<string, unknown>>(db, rpcName, { p_org_id: orgId });
  if (error) {
    logger.error({ error, orgId, ...context }, `${rpcName} RPC failed`);
    throw error;
  }
  logger.info({ orgId, ...context }, `${rpcName} RPC succeeded`);
}

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
    metadata?: { user_id?: string; price_id?: string; plan_id?: string };
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
  const metadataPlanId = session.metadata?.plan_id;
  const priceId = session.metadata?.price_id;

  if (metadataPlanId) {
    const { data: matchedPlan } = await db
      .from('plans')
      .select('id')
      .eq('id', metadataPlanId)
      .maybeSingle();

    if (matchedPlan) {
      planId = matchedPlan.id;
    }
  }

  if (!planId && priceId) {
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

  const profileTier = planId ? PROFILE_TIER_BY_PLAN_ID[planId] : null;
  if (profileTier) {
    const { error: tierError } = await db
      .from('profiles')
      .update({ subscription_tier: profileTier })
      .eq('id', userId);

    if (tierError) {
      logger.error({ tierError, userId, planId }, 'Failed to update profile subscription tier');
      throw tierError;
    }
  }

  // Log audit event
  await db.from('audit_events').insert({
    event_type: 'payment.subscription_created',
    event_category: 'ADMIN',
    actor_id: userId,
    details: `Subscription created: ${session.subscription}`,
  });

  // Propagate subscription activation to org: set verification_status = VERIFIED
  // and mark the admin profile as is_verified = true (Verified Admin badge).
  const { data: adminProfile } = await db
    .from('profiles')
    .select('org_id')
    .eq('id', userId)
    .maybeSingle();

  if (adminProfile?.org_id) {
    const orgId = adminProfile.org_id;

    // Read current KYB state first. Paying must NOT clear a prior Middesk
    // rejection — letting checkout flip REJECTED → VERIFIED would let any org
    // bypass KYB by subscribing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbAny = db as any;
    const { data: orgRow } = await dbAny
      .from('organizations')
      .select('verification_status')
      .eq('id', orgId)
      .maybeSingle();
    const currentStatus = orgRow?.verification_status as string | null | undefined;

    if (currentStatus === 'REJECTED') {
      logger.warn(
        { userId, orgId, currentStatus, subscriptionId: session.subscription },
        'Stripe checkout completed for org with REJECTED KYB status — leaving verification_status unchanged',
      );
      await db.from('audit_events').insert({
        event_type: 'CHECKOUT_BLOCKED_BY_KYB_REJECTION',
        event_category: 'ORG',
        actor_id: userId,
        org_id: orgId,
        details: `Subscription ${session.subscription} processed but verification_status left REJECTED (Middesk KYB)`,
      });
    } else {
      await db
        .from('organizations')
        .update({ verification_status: 'VERIFIED', updated_at: new Date().toISOString() })
        .eq('id', orgId);

      await db
        .from('profiles')
        .update({ is_verified: true })
        .eq('id', userId);

      await db.from('audit_events').insert({
        event_type: 'ORG_VERIFIED_VIA_SUBSCRIPTION',
        event_category: 'ORG',
        actor_id: userId,
        org_id: orgId,
        details: `Organization verification_status set to VERIFIED on checkout completion (subscription: ${session.subscription})`,
      });

      logger.info({ userId, orgId }, 'Org verification_status set to VERIFIED on checkout');
    }
  }

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
  const subscription = event.data.object as unknown as {
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
    subscription: StripeReference;
  };
  const stripeSubscriptionId = stripeReferenceId(invoice.subscription);

  logger.warn({ invoiceId: invoice.id, subscription: stripeSubscriptionId }, 'Payment failed');

  if (stripeSubscriptionId) {
    const { error } = await db
      .from('subscriptions')
      .update({ status: 'past_due' })
      .eq('stripe_subscription_id', stripeSubscriptionId);

    if (error) {
      logger.error({ error, invoiceId: invoice.id }, 'Failed to update subscription to past_due');
      throw error;
    }
  }

  if (stripeSubscriptionId) {
    const target = await resolvePaymentGraceTarget(stripeSubscriptionId);

    if (target.userId) {
      await db.from('audit_events').insert({
        event_type: 'payment.failed',
        event_category: 'ADMIN',
        actor_id: target.userId,
        details: `Payment failed for invoice: ${invoice.id}`,
      });
    }

    if (target.orgId) {
      await callPaymentGraceRpc('start_payment_grace', target.orgId, {
        invoiceId: invoice.id,
        stripeSubscriptionId,
      });
    }
  }
}

/**
 * Handle invoice.payment_succeeded
 *
 * Clears org payment grace and marks the subscription active again.
 */
export async function handlePaymentSucceeded(event: StripeEvent): Promise<void> {
  const invoice = event.data.object as {
    id: string;
    customer: string;
    subscription: StripeReference;
  };
  const stripeSubscriptionId = stripeReferenceId(invoice.subscription);

  logger.info({ invoiceId: invoice.id, subscription: stripeSubscriptionId }, 'Payment succeeded');

  if (!stripeSubscriptionId) return;

  const { error } = await db
    .from('subscriptions')
    .update({ status: 'active' })
    .eq('stripe_subscription_id', stripeSubscriptionId);

  if (error) {
    logger.error({ error, invoiceId: invoice.id }, 'Failed to update subscription to active');
    throw error;
  }

  const target = await resolvePaymentGraceTarget(stripeSubscriptionId);

  if (target.userId) {
    await db.from('audit_events').insert({
      event_type: 'payment.succeeded',
      event_category: 'ADMIN',
      actor_id: target.userId,
      details: `Payment succeeded for invoice: ${invoice.id}`,
    });
  }

  if (target.orgId) {
    await callPaymentGraceRpc('clear_payment_grace', target.orgId, {
      invoiceId: invoice.id,
      stripeSubscriptionId,
    });
  }
}

// =========================================================================
// Main Webhook Router
// =========================================================================

// =========================================================================
// Identity Verification Handlers (IDT WS1)
// =========================================================================

/**
 * Handle identity.verification_session.verified
 *
 * Stripe Identity has confirmed the user's identity. Update profile status.
 */
async function handleIdentityVerified(event: StripeEvent): Promise<void> {
  const session = event.data.object as { id: string; metadata?: { user_id?: string } };
  const userId = session.metadata?.user_id;

  if (!userId) {
    logger.warn({ sessionId: session.id }, 'Identity verification has no user_id in metadata');
    return;
  }

  const { error } = await db
    .from('profiles')
    .update({
      identity_verification_status: 'verified',
      identity_verified_at: new Date().toISOString(),
      is_verified: true,
      kyc_provider: 'stripe_identity',
    })
    .eq('id', userId)
    .eq('identity_verification_session_id', session.id);

  if (error) {
    logger.error({ error, userId }, 'Failed to update identity verification status to verified');
    throw error;
  }

  // Log audit event
  await db.from('audit_events').insert({
    actor_id: userId,
    event_type: 'IDENTITY_VERIFIED',
    event_category: 'ADMIN',
    details: `Identity verified via Stripe session ${session.id}`,
  });

  logger.info({ userId }, 'Identity verification completed successfully');
}

/**
 * Handle identity.verification_session.requires_input
 *
 * Stripe needs additional information — photos rejected, retry needed.
 */
async function handleIdentityRequiresInput(event: StripeEvent): Promise<void> {
  const session = event.data.object as { id: string; metadata?: { user_id?: string } };
  const userId = session.metadata?.user_id;

  if (!userId) return;

  await db
    .from('profiles')
    .update({ identity_verification_status: 'requires_input' })
    .eq('id', userId)
    .eq('identity_verification_session_id', session.id);

  logger.info({ userId }, 'Identity verification requires additional input');
}

/**
 * Handle identity.verification_session.canceled
 */
async function handleIdentityCanceled(event: StripeEvent): Promise<void> {
  const session = event.data.object as { id: string; metadata?: { user_id?: string } };
  const userId = session.metadata?.user_id;

  if (!userId) return;

  await db
    .from('profiles')
    .update({ identity_verification_status: 'canceled' })
    .eq('id', userId)
    .eq('identity_verification_session_id', session.id);

  logger.info({ userId }, 'Identity verification canceled');
}

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
  const obj = event.data.object as unknown as Record<string, unknown>;
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
    case 'invoice.payment_succeeded':
      await handlePaymentSucceeded(event);
      break;
    case 'identity.verification_session.verified':
      await handleIdentityVerified(event);
      break;
    case 'identity.verification_session.requires_input':
      await handleIdentityRequiresInput(event);
      break;
    case 'identity.verification_session.canceled':
      await handleIdentityCanceled(event);
      break;
    default:
      logger.info({ eventType: event.type }, 'Unhandled event type');
  }

  // Record as processed in billing_events (idempotency + audit)
  await recordEventProcessed(event.id, event.type, userId, obj as Record<string, unknown>);
}
