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
  profilesMaybeSingle,
  profilesUpdate,
  profilesUpdateEq,
  organizationsUpdate,
  organizationsMaybeSingle,
  mockCallRpc,
} = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const mockCallRpc = vi.fn();

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

  // subscriptions.upsert({}, { onConflict: 'stripe_subscription_id' })
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

  // profiles.select('org_id').eq('id', userId).maybeSingle()
  const profilesMaybeSingle = vi.fn().mockResolvedValue({ data: null });
  const profilesSelectEq = vi.fn(() => ({ maybeSingle: profilesMaybeSingle }));
  const profilesSelect = vi.fn(() => ({ eq: profilesSelectEq }));
  // profiles.update({}).eq('id', userId)          — single-eq chain (tier, is_verified)
  // profiles.update({}).eq('id', id).eq(sid, sid) — double-eq chain (identity verified)
  const profilesUpdateSecondEq = vi.fn().mockResolvedValue({ error: null });
  const profilesUpdateEq = vi.fn().mockImplementation(() => {
    const thenable = Promise.resolve({ error: null }) as Promise<{ error: unknown }> & {
      eq: typeof profilesUpdateSecondEq;
    };
    thenable.eq = profilesUpdateSecondEq;
    return thenable;
  });
  const profilesUpdate = vi.fn(() => ({ eq: profilesUpdateEq }));

  // organizations.update({}).eq('id', orgId)
  const organizationsUpdateEq = vi.fn().mockResolvedValue({ error: null });
  const organizationsUpdate = vi.fn(() => ({ eq: organizationsUpdateEq }));

  // organizations.select('verification_status').eq('id', orgId).maybeSingle()
  const organizationsMaybeSingle = vi.fn().mockResolvedValue({ data: null });
  const organizationsSelectEq = vi.fn(() => ({ maybeSingle: organizationsMaybeSingle }));
  const organizationsSelect = vi.fn(() => ({ eq: organizationsSelectEq }));

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
      case 'profiles':
        return {
          select: profilesSelect,
          update: profilesUpdate,
        };
      case 'organizations':
        return {
          select: organizationsSelect,
          update: organizationsUpdate,
        };
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
    profilesMaybeSingle,
    profilesUpdate,
    profilesUpdateEq,
    organizationsUpdate,
    organizationsMaybeSingle,
    mockCallRpc,
  };
});

// ---- Module mocks ----

vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../utils/db.js', () => ({ db: { from: mockDbFrom } }));
vi.mock('../utils/rpc.js', () => ({ callRpc: mockCallRpc }));

// ---- System under test ----

import {
  handleStripeWebhook,
  handleCheckoutComplete,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handlePaymentFailed,
  handlePaymentSucceeded,
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

// SCRUM-1267 (R2-4): API version 2026-03-25.dahlia moves period fields onto
// subscription.items.data[]. The handler now reads from items[0]; tests must
// match the new shape or they'd silently exercise the pre-fix RangeError path.
const SUBSCRIPTION_UPDATED_EVENT = makeStripeEvent('customer.subscription.updated', {
  id: 'sub_test_001',
  customer: 'cus_test_001',
  status: 'active',
  cancel_at_period_end: false,
  items: makeSubItems('price_test'),
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

const PAYMENT_SUCCEEDED_EVENT = makeStripeEvent('invoice.payment_succeeded', {
  id: 'inv_test_002',
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
  mockCallRpc.mockResolvedValue({ data: { ok: true }, error: null });
}

// SCRUM-1266 (R2-3) + PR #567 review-fix: shared assertions for the orphan-row
// guard pattern repeated across the 3 sibling Stripe handlers. Sonar flagged
// 33% duplication on the test file because each handler had near-identical
// missing-row + lookup-error pairs; centralised here.
async function expectOrphanRowGuardSkipsUpdate(
  handler: (e: Stripe.Event) => Promise<void>,
  event: Stripe.Event,
  context: Record<string, unknown>,
) {
  subscriptionsSelect.maybeSingle.mockResolvedValue({ data: null });
  await handler(event);
  expect(subscriptionsUpdate.update).not.toHaveBeenCalled();
  expect(auditInsert).not.toHaveBeenCalled();
  expect(mockLogger.warn).toHaveBeenCalledWith(
    expect.objectContaining(context),
    expect.stringContaining('SCRUM-1266'),
  );
}

async function expectLookupErrorThrows(
  handler: (e: Stripe.Event) => Promise<void>,
  event: Stripe.Event,
  err: Record<string, string>,
) {
  subscriptionsSelect.maybeSingle.mockResolvedValue({ data: null, error: err });
  await expect(handler(event)).rejects.toEqual(err);
  expect(subscriptionsUpdate.update).not.toHaveBeenCalled();
}

// SCRUM-1267 (R2-4): every customer.subscription.updated test fixture moved
// period fields onto items.data[0]. Build the items shape once so each test
// expresses only the per-test variance (price ID, period start/end).
function makeSubItems(
  priceId: string,
  start = 1710000000,
  end = 1712678400,
): { data: Array<{ price: { id: string }; current_period_start: number; current_period_end: number }> } {
  return {
    data: [{ price: { id: priceId }, current_period_start: start, current_period_end: end }],
  };
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

  it('routes invoice.payment_succeeded to handlePaymentSucceeded', async () => {
    subscriptionsSelect.maybeSingle.mockResolvedValue({
      data: { user_id: 'user-001', org_id: 'org-001', plan_id: 'plan-ind' },
    });
    await handleStripeWebhook(PAYMENT_SUCCEEDED_EVENT);
    expect(mockCallRpc).toHaveBeenCalledWith(
      expect.anything(),
      'clear_payment_grace',
      { p_org_id: 'org-001' },
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

  it('skips already-processed events (idempotency via UNIQUE violation)', async () => {
    billingEventsInsert.mockResolvedValueOnce({ error: { code: '23505', message: 'duplicate' } });
    await handleStripeWebhook(CHECKOUT_EVENT);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt_test_001' }),
      'Event already processed',
    );
    expect(subscriptionsUpsert).not.toHaveBeenCalled();
  });

  it('records event in billing_events BEFORE handling (idempotency boundary)', async () => {
    const callOrder: string[] = [];
    billingEventsInsert.mockImplementationOnce(() => {
      callOrder.push('billing_events.insert');
      return Promise.resolve({ error: null });
    });
    subscriptionsUpsert.mockImplementationOnce(() => {
      callOrder.push('subscriptions.upsert');
      return Promise.resolve({ error: null });
    });

    await handleStripeWebhook(CHECKOUT_EVENT);

    expect(billingEventsInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_event_id: 'evt_test_001',
        event_type: 'checkout.session.completed',
        user_id: 'user-001',
      }),
    );
    // Critical: billing_events MUST be written before any side effect.
    expect(callOrder.indexOf('billing_events.insert')).toBeLessThan(
      callOrder.indexOf('subscriptions.upsert'),
    );
  });

  it('extracts user_id from event metadata for billing_events', async () => {
    const noMetaEvent = makeStripeEvent('unknown.event.type', { some: 'data' }, 'evt_no_meta');
    await handleStripeWebhook(noMetaEvent);
    expect(billingEventsInsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: null }),
    );
  });

  it('SCRUM-1222: Stripe retry of already-processed event runs zero side effects', async () => {
    // Simulate: first delivery succeeded, billing_events row exists. Stripe
    // retries the same event_id. Insert hits UNIQUE violation → bail with
    // zero side effects.
    billingEventsInsert.mockResolvedValueOnce({ error: { code: '23505', message: 'duplicate' } });
    await handleStripeWebhook(CHECKOUT_EVENT);
    expect(subscriptionsUpsert).not.toHaveBeenCalled();
    expect(plansSelect.select).not.toHaveBeenCalled();
    expect(profilesUpdate).not.toHaveBeenCalled();
    expect(auditInsert).not.toHaveBeenCalled();
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
      { onConflict: 'stripe_subscription_id' },
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

  it('SCRUM-1218: does NOT flip verification_status to VERIFIED when org KYB is REJECTED', async () => {
    profilesMaybeSingle.mockResolvedValueOnce({ data: { org_id: 'org-rejected' } });
    organizationsMaybeSingle.mockResolvedValueOnce({ data: { verification_status: 'REJECTED' } });

    await handleCheckoutComplete(CHECKOUT_EVENT);

    // organizations.update is NOT called for the verification flip.
    expect(organizationsUpdate).not.toHaveBeenCalled();
    // ORG_VERIFIED_VIA_SUBSCRIPTION audit event is NOT emitted.
    expect(auditInsert).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'ORG_VERIFIED_VIA_SUBSCRIPTION' }),
    );
    // CHECKOUT_BLOCKED_BY_KYB_REJECTION audit event IS emitted.
    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'CHECKOUT_BLOCKED_BY_KYB_REJECTION',
        org_id: 'org-rejected',
        actor_id: 'user-001',
      }),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-rejected', currentStatus: 'REJECTED' }),
      expect.stringContaining('REJECTED'),
    );
  });

  it('SCRUM-1218: still flips to VERIFIED when current status is null/PENDING/etc.', async () => {
    profilesMaybeSingle.mockResolvedValueOnce({ data: { org_id: 'org-pending' } });
    organizationsMaybeSingle.mockResolvedValueOnce({ data: { verification_status: null } });

    await handleCheckoutComplete(CHECKOUT_EVENT);

    expect(organizationsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ verification_status: 'VERIFIED' }),
    );
    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'ORG_VERIFIED_VIA_SUBSCRIPTION' }),
    );
  });

  // -----------------------------------------------------------------
  // Coverage for SCRUM-1156 / ONBOARD-03: plan_id metadata lookup,
  // PROFILE_TIER_BY_PLAN_ID subscription_tier propagation,
  // identity verified is_verified/kyc_provider fields.
  // -----------------------------------------------------------------

  it('resolves plan via metadata.plan_id when present (preferred over price_id)', async () => {
    const event = makeStripeEvent('checkout.session.completed', {
      id: 'cs_plan_id',
      customer: 'cus_plan_id',
      subscription: 'sub_plan_id',
      metadata: { user_id: 'user-001', plan_id: 'small_business' },
    });
    plansSelectMaybeSingle.mockResolvedValue({ data: { id: 'small_business' } });
    await handleCheckoutComplete(event);
    expect(plansSelect.eq).toHaveBeenCalledWith('id', 'small_business');
    expect(subscriptionsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ plan_id: 'small_business' }),
      { onConflict: 'stripe_subscription_id' },
    );
  });

  it('falls back to price_id lookup when plan_id is missing', async () => {
    const event = makeStripeEvent('checkout.session.completed', {
      id: 'cs_price_id',
      customer: 'cus_price_id',
      subscription: 'sub_price_id',
      metadata: { user_id: 'user-001', price_id: 'price_small' },
    });
    plansSelectMaybeSingle.mockResolvedValue({ data: { id: 'small_business' } });
    await handleCheckoutComplete(event);
    expect(plansSelect.eq).toHaveBeenCalledWith('stripe_price_id', 'price_small');
  });

  it('updates profile subscription_tier for a mapped plan id', async () => {
    const event = makeStripeEvent('checkout.session.completed', {
      id: 'cs_tier_map',
      customer: 'cus_tier_map',
      subscription: 'sub_tier_map',
      metadata: { user_id: 'user-001', plan_id: 'individual_verified_annual' },
    });
    plansSelectMaybeSingle.mockResolvedValue({ data: { id: 'individual_verified_annual' } });
    await handleCheckoutComplete(event);
    expect(profilesUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ subscription_tier: 'verified_individual' }),
    );
    expect(profilesUpdateEq).toHaveBeenCalledWith('id', 'user-001');
  });

  it('does not update profile tier when planId is not in the tier map', async () => {
    const event = makeStripeEvent('checkout.session.completed', {
      id: 'cs_unknown_plan',
      customer: 'cus_unknown_plan',
      subscription: 'sub_unknown_plan',
      metadata: { user_id: 'user-001', plan_id: 'legacy_unmapped' },
    });
    plansSelectMaybeSingle.mockResolvedValue({ data: { id: 'legacy_unmapped' } });
    await handleCheckoutComplete(event);
    // profilesUpdate is also used for is_verified via org path; ensure
    // subscription_tier was NOT in any call.
    const tierCall = profilesUpdate.mock.calls.find((call: unknown[]) => {
      const arg = call[0] as Record<string, unknown> | undefined;
      return arg && Object.prototype.hasOwnProperty.call(arg, 'subscription_tier');
    });
    expect(tierCall).toBeUndefined();
  });

  it('throws when profile tier update fails', async () => {
    const event = makeStripeEvent('checkout.session.completed', {
      id: 'cs_tier_err',
      customer: 'cus_tier_err',
      subscription: 'sub_tier_err',
      metadata: { user_id: 'user-001', plan_id: 'small_business' },
    });
    plansSelectMaybeSingle.mockResolvedValue({ data: { id: 'small_business' } });
    const tierError = { message: 'tier update failed' };
    // First .eq() call (subscription_tier update) fails; subsequent calls use default.
    profilesUpdateEq.mockImplementationOnce(() => Promise.resolve({ error: tierError }));
    await expect(handleCheckoutComplete(event)).rejects.toEqual(tierError);
  });
});

// ================================================================
// Identity verification webhook (SCRUM-1156 — Stripe Identity CTA)
// ================================================================

describe('identity.verification_session.verified', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaults();
  });

  it('sets is_verified and kyc_provider on profile when verified', async () => {
    const event = makeStripeEvent(
      'identity.verification_session.verified',
      {
        id: 'vs_test_001',
        metadata: { user_id: 'user-001' },
      },
      'evt_identity_001',
    );
    await handleStripeWebhook(event);
    const verifiedCall = profilesUpdate.mock.calls.find((call: unknown[]) => {
      const arg = call[0] as Record<string, unknown> | undefined;
      return arg && arg.kyc_provider === 'stripe_identity';
    }) as [Record<string, unknown>] | undefined;
    expect(verifiedCall).toBeDefined();
    expect(verifiedCall?.[0]).toMatchObject({
      identity_verification_status: 'verified',
      is_verified: true,
      kyc_provider: 'stripe_identity',
    });
  });

  it('skips identity update when user_id missing from metadata', async () => {
    const event = makeStripeEvent(
      'identity.verification_session.verified',
      { id: 'vs_no_user' },
      'evt_identity_no_user',
    );
    await handleStripeWebhook(event);
    const verifiedCall = profilesUpdate.mock.calls.find((call: unknown[]) => {
      const arg = call[0] as Record<string, unknown> | undefined;
      return arg && arg.kyc_provider === 'stripe_identity';
    });
    expect(verifiedCall).toBeUndefined();
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
      cancel_at_period_end: false,
      items: makeSubItems('price_test'),
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
      cancel_at_period_end: false,
      items: makeSubItems('price_test'),
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
      cancel_at_period_end: false,
      items: makeSubItems('price_test'),
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
      cancel_at_period_end: false,
      items: makeSubItems('price_test'),
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
    // Subscription event with price items (period fields under items.data[0] per R2-4)
    const event = makeStripeEvent('customer.subscription.updated', {
      id: 'sub_test_001',
      customer: 'cus_test_001',
      status: 'active',
      cancel_at_period_end: false,
      items: makeSubItems('price_pro'),
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
      cancel_at_period_end: false,
      items: makeSubItems('price_ind'),
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
      cancel_at_period_end: true,
      items: makeSubItems('price_test'),
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

  // SCRUM-1267 (R2-4): items.data[0] is now mandatory (period fields live there).
  // The pre-R2-4 "handles missing price items gracefully" test exercised a path
  // that no longer exists — the handler throws if items.data[0] is missing.
  // Coverage for the throw lives in the R2-4 describe block below.
  it('emits plan_id in the update when items.data[0] has a resolvable price', async () => {
    plansSelectMaybeSingle.mockResolvedValue({ data: { id: 'plan-test' } });
    await handleSubscriptionUpdated(SUBSCRIPTION_UPDATED_EVENT);

    expect(subscriptionsUpdate.update).toHaveBeenCalledWith(
      expect.objectContaining({ plan_id: 'plan-test' }),
    );
  });

  it('handles unresolvable price (skips plan_id write to preserve NOT NULL invariant)', async () => {
    // subscriptions.plan_id is NON-NULL in schema. When the Stripe price
    // is unrecognised (newPlanId === null), we must NOT write the column
    // — leave the existing plan_id intact rather than triggering a
    // not-null violation at UPDATE time. Coderabbit P0 finding on PR #623.
    const event = makeStripeEvent('customer.subscription.updated', {
      id: 'sub_test_001',
      customer: 'cus_test_001',
      status: 'active',
      cancel_at_period_end: false,
      items: makeSubItems('price_unknown'),
    });

    plansSelectMaybeSingle.mockResolvedValue({ data: null });

    await handleSubscriptionUpdated(event);

    // The update fires (status/cancel still flow through) but plan_id
    // must be omitted from the payload — not written as null.
    expect(subscriptionsUpdate.update).toHaveBeenCalled();
    const updatePayload = subscriptionsUpdate.update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(updatePayload).not.toHaveProperty('plan_id');
    // Status/cancel still applied so the rest of the handler still works.
    expect(updatePayload).toMatchObject({ status: 'active', cancel_at_period_end: false });
  });

  // SCRUM-1239 (AUDIT-0424-14): the handler must refuse to UPDATE when no
  // subscription row exists for the stripe_subscription_id. Previously
  // updates wrote by stripe_subscription_id alone with no existence check —
  // a malformed or attacker-injected event could mutate state for an
  // unknown subscription (and the post-update SELECT would resolve org_id
  // to null, but the UPDATE had already fired).
  it('SCRUM-1239: does NOT update when no subscription row exists for stripe_subscription_id', async () => {
    // Subscription lookup returns no row.
    subscriptionsSelect.maybeSingle.mockResolvedValue({ data: null });

    await handleSubscriptionUpdated(SUBSCRIPTION_UPDATED_EVENT);

    // Critical: NO update fires.
    expect(subscriptionsUpdate.update).not.toHaveBeenCalled();
    // Should warn about the orphan event so it surfaces in logs.
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: 'sub_test_001' }),
      expect.stringMatching(/no subscription row|refusing to update/i),
    );
  });

  it('SCRUM-1239: does update when subscription row exists', async () => {
    // Existing subscription row resolves user_id (and implicitly org_id
    // upstream of the audit log).
    subscriptionsSelect.maybeSingle.mockResolvedValue({
      data: { user_id: 'user-001', plan_id: 'plan-ind', cancel_at_period_end: false },
    });

    await handleSubscriptionUpdated(SUBSCRIPTION_UPDATED_EVENT);

    expect(subscriptionsUpdate.update).toHaveBeenCalled();
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

  // SCRUM-1266 (R2-3) + PR #567 review-fix: orphan-row guard + lookup-error throw
  it('R2-3: refuses to UPDATE when subscription row is missing (orphan-row guard)', async () => {
    await expectOrphanRowGuardSkipsUpdate(
      handleSubscriptionDeleted,
      SUBSCRIPTION_DELETED_EVENT,
      { subscriptionId: 'sub_test_001' },
    );
  });

  it('PR #567 review-fix: throws when subscription lookup fails (DB error vs missing row)', async () => {
    await expectLookupErrorThrows(handleSubscriptionDeleted, SUBSCRIPTION_DELETED_EVENT, {
      message: 'connection lost',
      code: '08001',
    });
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

  it('starts payment grace for the subscription organization', async () => {
    subscriptionsSelect.maybeSingle.mockResolvedValue({
      data: { user_id: 'user-001', org_id: 'org-001' },
    });
    await handlePaymentFailed(PAYMENT_FAILED_EVENT);
    expect(mockCallRpc).toHaveBeenCalledWith(
      expect.anything(),
      'start_payment_grace',
      { p_org_id: 'org-001' },
    );
  });

  it('falls back to the profile org when subscription org_id is missing', async () => {
    subscriptionsSelect.maybeSingle.mockResolvedValue({
      data: { user_id: 'user-001', org_id: null },
    });
    profilesMaybeSingle.mockResolvedValueOnce({ data: { org_id: 'org-from-profile' } });
    await handlePaymentFailed(PAYMENT_FAILED_EVENT);
    expect(mockCallRpc).toHaveBeenCalledWith(
      expect.anything(),
      'start_payment_grace',
      { p_org_id: 'org-from-profile' },
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
    expect(mockCallRpc).not.toHaveBeenCalled();
  });

  it('throws when subscription update fails', async () => {
    subscriptionsUpdate.eq.mockResolvedValue({ error: { message: 'db error' } });
    await expect(handlePaymentFailed(PAYMENT_FAILED_EVENT)).rejects.toEqual({ message: 'db error' });
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('throws when start_payment_grace fails', async () => {
    subscriptionsSelect.maybeSingle.mockResolvedValue({
      data: { user_id: 'user-001', org_id: 'org-001' },
    });
    mockCallRpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(handlePaymentFailed(PAYMENT_FAILED_EVENT)).rejects.toEqual({ message: 'rpc failed' });
  });

  // SCRUM-1266 (R2-3) + PR #567 review-fix
  it('R2-3: refuses to UPDATE when subscription row is missing (orphan-row guard)', async () => {
    await expectOrphanRowGuardSkipsUpdate(handlePaymentFailed, PAYMENT_FAILED_EVENT, {
      subscriptionId: 'sub_test_001',
      invoiceId: 'inv_test_001',
    });
    expect(mockCallRpc).not.toHaveBeenCalled();
  });

  it('PR #567 review-fix: throws when subscription lookup fails (DB error vs missing row)', async () => {
    await expectLookupErrorThrows(handlePaymentFailed, PAYMENT_FAILED_EVENT, {
      message: 'rls denied',
      code: 'PGRST301',
    });
  });
});

// ================================================================
// handlePaymentSucceeded
// ================================================================

describe('handlePaymentSucceeded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaults();
  });

  it('logs payment success', async () => {
    await handlePaymentSucceeded(PAYMENT_SUCCEEDED_EVENT);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: 'inv_test_002', subscription: 'sub_test_001' }),
      'Payment succeeded',
    );
  });

  it('updates subscription to active', async () => {
    await handlePaymentSucceeded(PAYMENT_SUCCEEDED_EVENT);
    expect(subscriptionsUpdate.update).toHaveBeenCalledWith({ status: 'active' });
    expect(subscriptionsUpdate.eq).toHaveBeenCalledWith(
      'stripe_subscription_id',
      'sub_test_001',
    );
  });

  it('clears payment grace for the subscription organization', async () => {
    subscriptionsSelect.maybeSingle.mockResolvedValue({
      data: { user_id: 'user-001', org_id: 'org-001' },
    });
    await handlePaymentSucceeded(PAYMENT_SUCCEEDED_EVENT);
    expect(mockCallRpc).toHaveBeenCalledWith(
      expect.anything(),
      'clear_payment_grace',
      { p_org_id: 'org-001' },
    );
  });

  it('logs audit event for payment success', async () => {
    subscriptionsSelect.maybeSingle.mockResolvedValue({
      data: { user_id: 'user-001', org_id: 'org-001' },
    });
    await handlePaymentSucceeded(PAYMENT_SUCCEEDED_EVENT);
    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'payment.succeeded',
        event_category: 'ADMIN',
        actor_id: 'user-001',
      }),
    );
  });

  it('skips subscription update and RPC when no subscription on invoice', async () => {
    const noSubEvent = makeStripeEvent('invoice.payment_succeeded', {
      id: 'inv_test_003',
      customer: 'cus_test_002',
      subscription: null,
    });
    await handlePaymentSucceeded(noSubEvent);
    expect(subscriptionsUpdate.update).not.toHaveBeenCalled();
    expect(mockCallRpc).not.toHaveBeenCalled();
  });

  it('throws when clear_payment_grace fails', async () => {
    subscriptionsSelect.maybeSingle.mockResolvedValue({
      data: { user_id: 'user-001', org_id: 'org-001' },
    });
    mockCallRpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
    await expect(handlePaymentSucceeded(PAYMENT_SUCCEEDED_EVENT)).rejects.toEqual({ message: 'rpc failed' });
  });

  // SCRUM-1266 (R2-3) + PR #567 review-fix
  it('R2-3: refuses to UPDATE when subscription row is missing (orphan-row guard)', async () => {
    await expectOrphanRowGuardSkipsUpdate(handlePaymentSucceeded, PAYMENT_SUCCEEDED_EVENT, {
      subscriptionId: 'sub_test_001',
      invoiceId: 'inv_test_002',
    });
    expect(mockCallRpc).not.toHaveBeenCalled();
  });

  it('PR #567 review-fix: throws when subscription lookup fails (DB error vs missing row)', async () => {
    await expectLookupErrorThrows(handlePaymentSucceeded, PAYMENT_SUCCEEDED_EVENT, {
      message: 'connection refused',
      code: 'ECONNREFUSED',
    });
  });
});

// ================================================================
// SCRUM-1267 (R2-4): items.data[0].current_period_* migration
// ================================================================

describe('handleSubscriptionUpdated — R2-4 items.data[0] period fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaults();
  });

  it('reads period fields from subscription.items.data[0] (new API shape)', async () => {
    const event = makeStripeEvent('customer.subscription.updated', {
      id: 'sub_r2_4',
      customer: 'cus_r2_4',
      status: 'active',
      cancel_at_period_end: false,
      items: makeSubItems('price_r2_4', 1735689600, 1738368000),
    });

    await handleSubscriptionUpdated(event);

    expect(subscriptionsUpdate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        current_period_start: new Date(1735689600 * 1000).toISOString(),
        current_period_end: new Date(1738368000 * 1000).toISOString(),
      }),
    );
  });

  // PR #567 Codex P2 fix: under claim-first idempotency, throwing would lose
  // the event permanently. Instead we apply the status/cancel update without
  // period fields and surface the gap in logs/Sentry for operator action.
  it('PR #567 Codex P2 fix: applies status/cancel update without period fields when items[0] is missing', async () => {
    const event = makeStripeEvent('customer.subscription.updated', {
      id: 'sub_no_items',
      customer: 'cus_no_items',
      status: 'past_due',
      cancel_at_period_end: true,
      // no items field — pre-PR #567 we threw RangeError or an explicit Error,
      // both of which were silently swallowed by the claim-first idempotency layer.
    });

    await handleSubscriptionUpdated(event);

    expect(subscriptionsUpdate.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'past_due', cancel_at_period_end: true }),
    );
    // Period fields must NOT be present — we don't overwrite valid existing values with bogus ones
    const updateArg = (subscriptionsUpdate.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(updateArg).not.toHaveProperty('current_period_start');
    expect(updateArg).not.toHaveProperty('current_period_end');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: 'sub_no_items', itemsCount: 0 }),
      expect.stringContaining('missing items[0].current_period_start/_end'),
    );
  });

  it('PR #567 Codex P2 fix: applies partial update when items[0] has price but no period fields', async () => {
    const event = makeStripeEvent('customer.subscription.updated', {
      id: 'sub_partial',
      customer: 'cus_partial',
      status: 'active',
      cancel_at_period_end: false,
      items: { data: [{ price: { id: 'price_partial' } }] },
    });

    await handleSubscriptionUpdated(event);

    const updateArg = (subscriptionsUpdate.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(updateArg.status).toBe('active');
    expect(updateArg).not.toHaveProperty('current_period_start');
    expect(updateArg).not.toHaveProperty('current_period_end');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: 'sub_partial' }),
      expect.stringContaining('missing items[0].current_period_start/_end'),
    );
  });
});
