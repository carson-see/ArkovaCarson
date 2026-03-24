/**
 * Unit tests for Stripe webhook handlers
 *
 * Rewritten for current handlers.ts which uses:
 * - billing_events table for idempotency
 * - subscriptions table for subscription state
 * - plans table for plan lookup
 * - audit_events for compliance logging
 *
 * @see P7-TS-02, P7-TS-03
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';

// ---- Hoisted mocks ----

const {
  mockLogger,
  mockDbFrom,
  billingEventsSelect,
  billingEventsInsert,
  plansSelect,
  plansSelectMaybeSingle,
  subscriptionsUpsert,
  subscriptionsUpdate,
  subscriptionsSelect,
  auditInsert,
} = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  // billing_events.select('id').eq('stripe_event_id', id).maybeSingle()
  const billingEventsMaybeSingle = vi.fn();
  const billingEventsSelectEq = vi.fn(() => ({ maybeSingle: billingEventsMaybeSingle }));
  const billingEventsSelect = {
    select: vi.fn(() => ({ eq: billingEventsSelectEq })),
    eq: billingEventsSelectEq,
    maybeSingle: billingEventsMaybeSingle,
  };

  // billing_events.insert({})
  const billingEventsInsert = vi.fn();

  // plans.select('id, stripe_price_id').not('stripe_price_id', 'is', null)
  // plans.select('id').eq('stripe_price_id', priceId).maybeSingle()
  const plansSelectNot = vi.fn();
  const plansSelectMaybeSingle = vi.fn();
  const plansSelectEq = vi.fn(() => ({ maybeSingle: plansSelectMaybeSingle }));
  const plansSelect = {
    select: vi.fn((fields: string) => {
      if (fields === 'id') {
        return { eq: plansSelectEq };
      }
      return { not: plansSelectNot, eq: plansSelectEq };
    }),
    not: plansSelectNot,
    eq: plansSelectEq,
    maybeSingle: plansSelectMaybeSingle,
  };

  // subscriptions.upsert({}, { onConflict: 'user_id' })
  const subscriptionsUpsert = vi.fn();

  // subscriptions.update({}).eq('stripe_subscription_id', id)
  const subscriptionsUpdateEq = vi.fn();
  const subscriptionsUpdate = {
    update: vi.fn(() => ({ eq: subscriptionsUpdateEq })),
    eq: subscriptionsUpdateEq,
  };

  // subscriptions.select('user_id').eq(...).maybeSingle()
  // subscriptions.select('user_id, plan_id').eq(...).maybeSingle()
  const subscriptionsSelectMaybeSingle = vi.fn();
  const subscriptionsSelectEq = vi.fn(() => ({ maybeSingle: subscriptionsSelectMaybeSingle }));
  const subscriptionsSelect = {
    select: vi.fn(() => ({ eq: subscriptionsSelectEq })),
    eq: subscriptionsSelectEq,
    maybeSingle: subscriptionsSelectMaybeSingle,
  };

  // audit_events.insert({})
  const auditInsert = vi.fn();

  const mockDbFrom = vi.fn((table: string) => {
    switch (table) {
      case 'billing_events':
        return {
          select: billingEventsSelect.select,
          insert: billingEventsInsert,
        };
      case 'plans':
        return { select: plansSelect.select };
      case 'subscriptions':
        return {
          upsert: subscriptionsUpsert,
          update: subscriptionsUpdate.update,
          select: subscriptionsSelect.select,
        };
      case 'audit_events':
        return { insert: auditInsert };
      default:
        return {};
    }
  });

  return {
    mockLogger,
    mockDbFrom,
    billingEventsSelect,
    billingEventsInsert,
    plansSelect,
    plansSelectMaybeSingle,
    subscriptionsUpsert,
    subscriptionsUpdate,
    subscriptionsSelect,
    auditInsert,
  };
});

// ---- Module mocks ----

vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../utils/db.js', () => ({ db: { from: mockDbFrom } }));
vi.mock('../billing/reconciliation.js', () => ({
  createGracePeriod: vi.fn().mockResolvedValue(undefined),
}));

// ---- System under test ----

import {
  handleStripeWebhook,
  handleCheckoutComplete,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handlePaymentFailed,
} from './handlers.js';

// ---- Test fixtures ----

function makeStripeEvent(
  type: string,
  object: Record<string, unknown>,
  id = 'evt_test_001',
): Stripe.Event {
  return {
    id,
    type,
    data: { object },
    object: 'event',
    api_version: '2023-10-16',
    created: Date.now() / 1000,
    livemode: false,
    pending_webhooks: 0,
    request: null,
  } as unknown as Stripe.Event;
}

const CHECKOUT_EVENT = makeStripeEvent('checkout.session.completed', {
  id: 'cs_test_001',
  customer: 'cus_test_001',
  subscription: 'sub_test_001',
  metadata: { user_id: 'user-001' },
});

const SUBSCRIPTION_UPDATED_EVENT = makeStripeEvent('customer.subscription.updated', {
  id: 'sub_test_001',
  customer: 'cus_test_001',
  status: 'active',
  current_period_start: 1710000000,
  current_period_end: 1712678400,
  cancel_at_period_end: false,
});

const SUBSCRIPTION_DELETED_EVENT = makeStripeEvent('customer.subscription.deleted', {
  id: 'sub_test_001',
  customer: 'cus_test_001',
});

const PAYMENT_FAILED_EVENT = makeStripeEvent('invoice.payment_failed', {
  id: 'inv_test_001',
  customer: 'cus_test_001',
  subscription: 'sub_test_001',
});

// ================================================================
// Setup defaults
// ================================================================

function setupDefaults() {
  // billing_events: event not yet processed
  billingEventsSelect.maybeSingle.mockResolvedValue({ data: null });
  billingEventsInsert.mockResolvedValue({ error: null });

  // plans: return some plans (for checkout fallback)
  plansSelect.not.mockResolvedValue({
    data: [{ id: 'plan-ind', stripe_price_id: 'price_ind' }],
  });
  // plans: price lookup (for subscription update plan change detection)
  plansSelectMaybeSingle.mockResolvedValue({ data: null });

  // subscriptions: upsert succeeds
  subscriptionsUpsert.mockResolvedValue({ error: null });
  subscriptionsUpdate.eq.mockResolvedValue({ error: null });
  subscriptionsSelect.maybeSingle.mockResolvedValue({
    data: { user_id: 'user-001', plan_id: 'plan-ind' },
  });

  // audit: succeeds
  auditInsert.mockResolvedValue({ error: null });
}

// ================================================================
// handleStripeWebhook — routing + idempotency
// ================================================================

describe('handleStripeWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaults();
  });

  it('routes checkout.session.completed to handleCheckoutComplete', async () => {
    await handleStripeWebhook(CHECKOUT_EVENT);
    expect(mockDbFrom).toHaveBeenCalledWith('subscriptions');
    expect(subscriptionsUpsert).toHaveBeenCalled();
  });

  it('routes customer.subscription.updated to handleSubscriptionUpdated', async () => {
    await handleStripeWebhook(SUBSCRIPTION_UPDATED_EVENT);
    expect(subscriptionsUpdate.update).toHaveBeenCalled();
  });

  it('routes customer.subscription.deleted to handleSubscriptionDeleted', async () => {
    await handleStripeWebhook(SUBSCRIPTION_DELETED_EVENT);
    expect(subscriptionsUpdate.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'canceled' }),
    );
  });

  it('routes invoice.payment_failed to handlePaymentFailed', async () => {
    await handleStripeWebhook(PAYMENT_FAILED_EVENT);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: 'inv_test_001' }),
      'Payment failed',
    );
  });

  it('logs unhandled event types without error', async () => {
    const unknownEvent = makeStripeEvent('unknown.event.type', {});
    await handleStripeWebhook(unknownEvent);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'unknown.event.type' }),
      'Unhandled event type',
    );
  });

  it('skips already-processed events (idempotency)', async () => {
    billingEventsSelect.maybeSingle.mockResolvedValue({ data: { id: 'existing' } });
    await handleStripeWebhook(CHECKOUT_EVENT);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt_test_001' }),
      'Event already processed',
    );
    expect(subscriptionsUpsert).not.toHaveBeenCalled();
  });

  it('records event in billing_events after handling', async () => {
    await handleStripeWebhook(CHECKOUT_EVENT);
    expect(billingEventsInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_event_id: 'evt_test_001',
        event_type: 'checkout.session.completed',
        user_id: 'user-001',
      }),
    );
  });

  it('extracts user_id from event metadata for billing_events', async () => {
    const noMetaEvent = makeStripeEvent('unknown.event.type', { some: 'data' }, 'evt_no_meta');
    await handleStripeWebhook(noMetaEvent);
    expect(billingEventsInsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: null }),
    );
  });

  it('handles duplicate billing_events insert gracefully (23505)', async () => {
    billingEventsInsert.mockResolvedValue({ error: { code: '23505', message: 'duplicate' } });
    // Should not throw
    await handleStripeWebhook(makeStripeEvent('unknown.event.type', {}));
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt_test_001' }),
      'Event already recorded (duplicate)',
    );
  });

  it('throws on non-duplicate billing_events insert error', async () => {
    const dbError = { code: '08001', message: 'connection refused' };
    billingEventsInsert.mockResolvedValue({ error: dbError });
    await expect(
      handleStripeWebhook(makeStripeEvent('unknown.event.type', {}, 'evt_fail')),
    ).rejects.toEqual(dbError);
  });
});

// ================================================================
// handleCheckoutComplete
// ================================================================

describe('handleCheckoutComplete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaults();
  });

  it('upserts subscription with user_id, plan_id, stripe IDs', async () => {
    await handleCheckoutComplete(CHECKOUT_EVENT);
    expect(subscriptionsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-001',
        stripe_subscription_id: 'sub_test_001',
        stripe_customer_id: 'cus_test_001',
        status: 'active',
      }),
      { onConflict: 'user_id' },
    );
  });

  it('looks up plan from plans table', async () => {
    await handleCheckoutComplete(CHECKOUT_EVENT);
    expect(mockDbFrom).toHaveBeenCalledWith('plans');
    expect(plansSelect.select).toHaveBeenCalledWith('id, stripe_price_id');
  });

  it('throws when no plans match and multiple plans exist', async () => {
    plansSelect.not.mockResolvedValue({ data: [{ id: 'a' }, { id: 'b' }] });
    await expect(handleCheckoutComplete(CHECKOUT_EVENT)).rejects.toThrow(
      'Could not resolve plan from checkout session',
    );
    expect(subscriptionsUpsert).not.toHaveBeenCalled();
  });

  it('logs audit event for subscription creation', async () => {
    await handleCheckoutComplete(CHECKOUT_EVENT);
    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'payment.subscription_created',
        event_category: 'ADMIN',
        actor_id: 'user-001',
      }),
    );
  });

  it('returns early when user_id is missing from metadata', async () => {
    const noUserEvent = makeStripeEvent('checkout.session.completed', {
      id: 'cs_test_002',
      customer: 'cus_test_002',
      subscription: 'sub_test_002',
      metadata: {},
    });
    await handleCheckoutComplete(noUserEvent);
    expect(mockLogger.error).toHaveBeenCalledWith('No user_id in session metadata');
    expect(subscriptionsUpsert).not.toHaveBeenCalled();
  });

  it('returns early when metadata is undefined', async () => {
    const noMetaEvent = makeStripeEvent('checkout.session.completed', {
      id: 'cs_test_003',
      customer: 'cus_test_003',
      subscription: 'sub_test_003',
    });
    await handleCheckoutComplete(noMetaEvent);
    expect(mockLogger.error).toHaveBeenCalledWith('No user_id in session metadata');
  });

  it('throws when subscription upsert fails', async () => {
    const dbError = { message: 'connection refused', code: '08001' };
    subscriptionsUpsert.mockResolvedValue({ error: dbError });
    await expect(handleCheckoutComplete(CHECKOUT_EVENT)).rejects.toEqual(dbError);
  });

  it('does not insert audit event when upsert fails', async () => {
    subscriptionsUpsert.mockResolvedValue({ error: { message: 'fail' } });
    await expect(handleCheckoutComplete(CHECKOUT_EVENT)).rejects.toBeDefined();
    expect(auditInsert).not.toHaveBeenCalled();
  });

  it('logs session ID on processing', async () => {
    await handleCheckoutComplete(CHECKOUT_EVENT);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'cs_test_001' }),
      'Processing checkout completion',
    );
  });

  it('logs subscription activation on success', async () => {
    await handleCheckoutComplete(CHECKOUT_EVENT);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-001', subscriptionId: 'sub_test_001' }),
      'Subscription activated',
    );
  });
});

// ================================================================
// handleSubscriptionUpdated
// ================================================================

describe('handleSubscriptionUpdated', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaults();
  });

  it('updates subscription status and period dates', async () => {
    await handleSubscriptionUpdated(SUBSCRIPTION_UPDATED_EVENT);
    expect(subscriptionsUpdate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'active',
        cancel_at_period_end: false,
      }),
    );
    expect(subscriptionsUpdate.eq).toHaveBeenCalledWith(
      'stripe_subscription_id',
      'sub_test_001',
    );
  });

  it('maps Stripe past_due status correctly', async () => {
    const event = makeStripeEvent('customer.subscription.updated', {
      id: 'sub_test_001',
      customer: 'cus_test_001',
      status: 'past_due',
      current_period_start: 1710000000,
      current_period_end: 1712678400,
      cancel_at_period_end: false,
    });
    await handleSubscriptionUpdated(event);
    expect(subscriptionsUpdate.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'past_due' }),
    );
  });

  it('maps Stripe unpaid to past_due', async () => {
    const event = makeStripeEvent('customer.subscription.updated', {
      id: 'sub_002',
      customer: 'cus_002',
      status: 'unpaid',
      current_period_start: 1710000000,
      current_period_end: 1712678400,
      cancel_at_period_end: false,
    });
    await handleSubscriptionUpdated(event);
    expect(subscriptionsUpdate.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'past_due' }),
    );
  });

  it('maps incomplete_expired to canceled', async () => {
    const event = makeStripeEvent('customer.subscription.updated', {
      id: 'sub_003',
      customer: 'cus_003',
      status: 'incomplete_expired',
      current_period_start: 1710000000,
      current_period_end: 1712678400,
      cancel_at_period_end: false,
    });
    await handleSubscriptionUpdated(event);
    expect(subscriptionsUpdate.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'canceled' }),
    );
  });

  it('defaults unknown status to active', async () => {
    const event = makeStripeEvent('customer.subscription.updated', {
      id: 'sub_004',
      customer: 'cus_004',
      status: 'some_future_status',
      current_period_start: 1710000000,
      current_period_end: 1712678400,
      cancel_at_period_end: false,
    });
    await handleSubscriptionUpdated(event);
    expect(subscriptionsUpdate.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active' }),
    );
  });

  it('throws when DB update fails', async () => {
    const dbError = { message: 'timeout', code: '08001' };
    subscriptionsUpdate.eq.mockResolvedValue({ error: dbError });
    await expect(handleSubscriptionUpdated(SUBSCRIPTION_UPDATED_EVENT)).rejects.toEqual(dbError);
  });

  it('logs subscription update info', async () => {
    await handleSubscriptionUpdated(SUBSCRIPTION_UPDATED_EVENT);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: 'sub_test_001', status: 'active' }),
      expect.stringContaining('update'),
    );
  });

  // ---- Plan change detection (MVP-11) ----

  it('detects plan change and updates plan_id', async () => {
    // Subscription event with price items
    const event = makeStripeEvent('customer.subscription.updated', {
      id: 'sub_test_001',
      customer: 'cus_test_001',
      status: 'active',
      current_period_start: 1710000000,
      current_period_end: 1712678400,
      cancel_at_period_end: false,
      items: { data: [{ price: { id: 'price_pro' } }] },
    });

    // Plan lookup resolves new plan
    plansSelectMaybeSingle.mockResolvedValue({ data: { id: 'plan-pro' } });
    // Existing subscription has different plan
    subscriptionsSelect.maybeSingle.mockResolvedValue({
      data: { user_id: 'user-001', plan_id: 'plan-ind' },
    });

    await handleSubscriptionUpdated(event);

    // Should update with new plan_id
    expect(subscriptionsUpdate.update).toHaveBeenCalledWith(
      expect.objectContaining({ plan_id: 'plan-pro' }),
    );

    // Should log audit event for plan change
    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'payment.plan_changed',
        event_category: 'ADMIN',
        actor_id: 'user-001',
      }),
    );
  });

  it('does not log plan change when plan_id is the same', async () => {
    const event = makeStripeEvent('customer.subscription.updated', {
      id: 'sub_test_001',
      customer: 'cus_test_001',
      status: 'active',
      current_period_start: 1710000000,
      current_period_end: 1712678400,
      cancel_at_period_end: false,
      items: { data: [{ price: { id: 'price_ind' } }] },
    });

    // Same plan
    plansSelectMaybeSingle.mockResolvedValue({ data: { id: 'plan-ind' } });
    subscriptionsSelect.maybeSingle.mockResolvedValue({
      data: { user_id: 'user-001', plan_id: 'plan-ind' },
    });

    await handleSubscriptionUpdated(event);

    // Should NOT log plan change audit event
    expect(auditInsert).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'payment.plan_changed' }),
    );
  });

  it('logs cancellation scheduled when cancel_at_period_end is true', async () => {
    const event = makeStripeEvent('customer.subscription.updated', {
      id: 'sub_test_001',
      customer: 'cus_test_001',
      status: 'active',
      current_period_start: 1710000000,
      current_period_end: 1712678400,
      cancel_at_period_end: true,
    });

    subscriptionsSelect.maybeSingle.mockResolvedValue({
      data: { user_id: 'user-001', plan_id: 'plan-ind' },
    });

    await handleSubscriptionUpdated(event);

    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'payment.subscription_cancel_scheduled',
        event_category: 'ADMIN',
        actor_id: 'user-001',
      }),
    );
  });

  it('does not log cancellation when cancel_at_period_end is false', async () => {
    await handleSubscriptionUpdated(SUBSCRIPTION_UPDATED_EVENT);

    expect(auditInsert).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'payment.subscription_cancel_scheduled' }),
    );
  });

  it('handles missing price items gracefully (no plan change)', async () => {
    // Event without items (original fixture)
    await handleSubscriptionUpdated(SUBSCRIPTION_UPDATED_EVENT);

    // Should still update subscription
    expect(subscriptionsUpdate.update).toHaveBeenCalled();
    // Should not include plan_id in update (no price to resolve)
    expect(subscriptionsUpdate.update).toHaveBeenCalledWith(
      expect.not.objectContaining({ plan_id: expect.anything() }),
    );
  });

  it('handles unresolvable price (sets plan_id to null)', async () => {
    const event = makeStripeEvent('customer.subscription.updated', {
      id: 'sub_test_001',
      customer: 'cus_test_001',
      status: 'active',
      current_period_start: 1710000000,
      current_period_end: 1712678400,
      cancel_at_period_end: false,
      items: { data: [{ price: { id: 'price_unknown' } }] },
    });

    plansSelectMaybeSingle.mockResolvedValue({ data: null });

    await handleSubscriptionUpdated(event);

    // Should update with plan_id explicitly set to null
    expect(subscriptionsUpdate.update).toHaveBeenCalledWith(
      expect.objectContaining({ plan_id: null }),
    );
  });
});

// ================================================================
// handleSubscriptionDeleted
// ================================================================

describe('handleSubscriptionDeleted', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaults();
  });

  it('sets subscription status to canceled', async () => {
    await handleSubscriptionDeleted(SUBSCRIPTION_DELETED_EVENT);
    expect(subscriptionsUpdate.update).toHaveBeenCalledWith({ status: 'canceled' });
    expect(subscriptionsUpdate.eq).toHaveBeenCalledWith(
      'stripe_subscription_id',
      'sub_test_001',
    );
  });

  it('looks up user_id for audit log', async () => {
    await handleSubscriptionDeleted(SUBSCRIPTION_DELETED_EVENT);
    expect(subscriptionsSelect.select).toHaveBeenCalledWith('user_id');
  });

  it('logs audit event when user found', async () => {
    subscriptionsSelect.maybeSingle.mockResolvedValue({
      data: { user_id: 'user-001' },
    });
    await handleSubscriptionDeleted(SUBSCRIPTION_DELETED_EVENT);
    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'payment.subscription_canceled',
        event_category: 'ADMIN',
        actor_id: 'user-001',
      }),
    );
  });

  it('skips audit event when user not found', async () => {
    subscriptionsSelect.maybeSingle.mockResolvedValue({ data: null });
    await handleSubscriptionDeleted(SUBSCRIPTION_DELETED_EVENT);
    expect(auditInsert).not.toHaveBeenCalled();
  });

  it('throws when DB update fails', async () => {
    const dbError = { message: 'fail' };
    subscriptionsUpdate.eq.mockResolvedValue({ error: dbError });
    await expect(handleSubscriptionDeleted(SUBSCRIPTION_DELETED_EVENT)).rejects.toEqual(dbError);
  });

  it('logs subscription deletion', async () => {
    await handleSubscriptionDeleted(SUBSCRIPTION_DELETED_EVENT);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: 'sub_test_001' }),
      expect.stringContaining('cancel'),
    );
  });
});

// ================================================================
// handlePaymentFailed
// ================================================================

describe('handlePaymentFailed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaults();
  });

  it('logs payment failure as warning', async () => {
    await handlePaymentFailed(PAYMENT_FAILED_EVENT);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: 'inv_test_001', subscription: 'sub_test_001' }),
      'Payment failed',
    );
  });

  it('updates subscription to past_due', async () => {
    await handlePaymentFailed(PAYMENT_FAILED_EVENT);
    expect(subscriptionsUpdate.update).toHaveBeenCalledWith({ status: 'past_due' });
    expect(subscriptionsUpdate.eq).toHaveBeenCalledWith(
      'stripe_subscription_id',
      'sub_test_001',
    );
  });

  it('logs audit event for payment failure', async () => {
    subscriptionsSelect.maybeSingle.mockResolvedValue({
      data: { user_id: 'user-001' },
    });
    await handlePaymentFailed(PAYMENT_FAILED_EVENT);
    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'payment.failed',
        event_category: 'ADMIN',
        actor_id: 'user-001',
      }),
    );
  });

  it('skips subscription update when no subscription on invoice', async () => {
    const noSubEvent = makeStripeEvent('invoice.payment_failed', {
      id: 'inv_test_002',
      customer: 'cus_test_002',
      subscription: null,
    });
    await handlePaymentFailed(noSubEvent);
    expect(subscriptionsUpdate.update).not.toHaveBeenCalled();
  });

  it('throws when subscription update fails', async () => {
    subscriptionsUpdate.eq.mockResolvedValue({ error: { message: 'db error' } });
    await expect(handlePaymentFailed(PAYMENT_FAILED_EVENT)).rejects.toThrow('db error');
    expect(mockLogger.error).toHaveBeenCalled();
  });
});
