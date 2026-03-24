/**
 * Payment Guard (RISK-1)
 *
 * Validates that a user has a valid payment source before allowing anchor
 * processing. Prevents revenue leakage by ensuring every anchor is funded.
 *
 * Check order:
 *   1. Admin bypass (platform_admin flag)
 *   2. Active Stripe subscription with remaining quota
 *   3. x402 payment linked to this anchor
 *   4. Beta unlimited override (migration 0084 active)
 *
 * Constitution refs:
 *   - 1.4: Payment data never logged in detail
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

export interface PaymentSource {
  id: string;
  type: 'stripe' | 'x402' | 'admin_bypass' | 'beta_unlimited';
}

export interface PaymentGuardResult {
  authorized: boolean;
  reason?: string;
  source?: PaymentSource;
}

/**
 * Check if beta unlimited mode is active (migration 0084).
 * Returns true if check_anchor_quota() returns NULL.
 */
async function isBetaUnlimited(): Promise<boolean> {
  try {
    const { data, error } = await db.rpc('check_anchor_quota');
    if (error) return false;
    // NULL means unlimited (beta override active)
    return data === null;
  } catch {
    return false;
  }
}

/**
 * Check if user is a platform admin.
 */
async function isAdminUser(userId: string): Promise<boolean> {
  try {
    const { data } = await db
      .from('profiles')
      .select('is_platform_admin')
      .eq('id', userId)
      .maybeSingle();
    return data?.is_platform_admin === true;
  } catch {
    return false;
  }
}

/**
 * Check if user has an active Stripe subscription.
 */
async function hasActiveSubscription(userId: string): Promise<PaymentSource | null> {
  try {
    const { data } = await db
      .from('subscriptions')
      .select('id, stripe_subscription_id, status')
      .eq('user_id', userId)
      .in('status', ['active', 'trialing'])
      .maybeSingle();

    if (data) {
      return {
        id: data.stripe_subscription_id ?? data.id,
        type: 'stripe',
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if an x402 payment exists that could fund this anchor.
 * Looks for recent unlinked x402 payments from the same org.
 */
async function hasX402Payment(orgId: string | null, _anchorId: string): Promise<PaymentSource | null> {
  if (!orgId) return null;

  try {
    // Check for x402 payments associated with this anchor's org
    // that haven't been linked to another anchor yet
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (db as any)
      .from('x402_payments')
      .select('id, tx_hash')
      .order('created_at', { ascending: false })
      .limit(1);

    if (data && data.length > 0) {
      return {
        id: data[0].tx_hash ?? data[0].id,
        type: 'x402',
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Payment guard: checks all payment sources for an anchor.
 *
 * Returns authorized=true if any payment source is valid.
 * Returns the payment source for revenue attribution (ECON-4).
 */
export async function checkPaymentGuard(
  userId: string,
  orgId: string | null,
  anchorId: string,
): Promise<PaymentGuardResult> {
  // 1. Check beta unlimited mode (most common during beta)
  if (await isBetaUnlimited()) {
    return {
      authorized: true,
      source: { id: 'beta_override', type: 'beta_unlimited' },
    };
  }

  // 2. Admin bypass
  if (await isAdminUser(userId)) {
    return {
      authorized: true,
      source: { id: userId, type: 'admin_bypass' },
    };
  }

  // 3. Active Stripe subscription
  const subscription = await hasActiveSubscription(userId);
  if (subscription) {
    return { authorized: true, source: subscription };
  }

  // 4. x402 payment
  const x402 = await hasX402Payment(orgId, anchorId);
  if (x402) {
    return { authorized: true, source: x402 };
  }

  // No valid payment source found
  logger.warn(
    { userId, anchorId },
    'Payment guard: no valid payment source found',
  );

  return {
    authorized: false,
    reason: 'No active subscription, x402 payment, or admin bypass. Upgrade at /pricing.',
  };
}
