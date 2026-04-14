/**
 * Stripe Metered Billing (PAY-02 / SCRUM-443)
 *
 * Enterprise usage-based billing via Stripe metered subscriptions.
 * Records API usage per billing period, reported to Stripe for monthly invoicing.
 *
 * Flow:
 *   1. Enterprise customer subscribes to metered plan
 *   2. Each API call records a usage event in billing_events
 *   3. Cron job reports aggregated usage to Stripe at end of billing period
 *   4. Stripe generates invoice automatically
 *
 * Constitution refs:
 *   - 1.4: No PII in usage records
 *   - 1.7: No real Stripe calls in tests — mock everything
 */

import { db } from '../utils/db.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export interface MeteredUsageRecord {
  org_id: string;
  user_id: string;
  endpoint: string;
  quantity: number;
  timestamp: string;
}

export interface UsageReportResult {
  org_id: string;
  total_usage: number;
  reported_to_stripe: boolean;
  stripe_subscription_item_id?: string;
  error?: string;
}

/**
 * Record metered API usage for an organization.
 * Stores in billing_events for aggregation + Stripe reporting.
 */
export async function recordMeteredUsage(record: MeteredUsageRecord): Promise<void> {
  const { error } = await db.from('billing_events').insert({
    org_id: record.org_id,
    user_id: record.user_id,
    event_type: 'metered_api_usage',
    payload: {
      endpoint: record.endpoint,
      quantity: record.quantity,
      timestamp: record.timestamp,
    },
  });

  if (error) {
    logger.error({ error, org_id: record.org_id }, 'Failed to record metered usage');
    throw error;
  }
}

/**
 * Get aggregated usage for an organization in a billing period.
 */
export async function getMeteredUsage(
  orgId: string,
  periodStart: string,
  periodEnd: string,
): Promise<number> {
  const { data, error } = await db
    .from('billing_events')
    .select('payload')
    .eq('org_id', orgId)
    .eq('event_type', 'metered_api_usage')
    .gte('processed_at', periodStart)
    .lte('processed_at', periodEnd);

  if (error) {
    logger.error({ error, orgId }, 'Failed to fetch metered usage');
    return 0;
  }

  return (data ?? []).reduce((sum, row) => {
    const qty = (row.payload as { quantity?: number })?.quantity ?? 1;
    return sum + qty;
  }, 0);
}

/**
 * Report metered usage to Stripe for all organizations with active metered subscriptions.
 * Called by cron job at end of billing period.
 */
export async function reportMeteredUsageToStripe(): Promise<UsageReportResult[]> {
  const results: UsageReportResult[] = [];

  // Find all orgs with active metered subscriptions
  // Note: subscriptions table uses plan_id FK to plans table, not plan_type column
  const { data: subs, error: subError } = await db
    .from('subscriptions')
    .select('id, user_id, org_id, stripe_subscription_id, plan_id')
    .in('status', ['active', 'trialing']);

  if (subError || !subs?.length) {
    logger.info('No active metered subscriptions found');
    return results;
  }

  for (const sub of subs) {
    const orgId = sub.org_id;
    if (!orgId) continue;

    // Get usage since last report
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const periodEnd = now.toISOString();

    const totalUsage = await getMeteredUsage(orgId, periodStart, periodEnd);

    if (totalUsage === 0) {
      results.push({ org_id: orgId, total_usage: 0, reported_to_stripe: false });
      continue;
    }

    try {
      if (!config.stripeSecretKey) {
        // Dev mode — log but don't call Stripe
        logger.info({ orgId, totalUsage }, 'Metered usage (dev mode, not reported to Stripe)');
        results.push({ org_id: orgId, total_usage: totalUsage, reported_to_stripe: false });
        continue;
      }

      // Report to Stripe
      const stripe = (await import('stripe')).default;
      const stripeClient = new stripe(config.stripeSecretKey);

      // Get subscription items to find the metered item
      const subscriptionItems = await stripeClient.subscriptionItems.list({
        subscription: sub.stripe_subscription_id!,
      });

      const meteredItem = subscriptionItems.data.find(
        (item) => item.price?.recurring?.usage_type === 'metered',
      );

      if (!meteredItem) {
        results.push({
          org_id: orgId,
          total_usage: totalUsage,
          reported_to_stripe: false,
          error: 'No metered price item found on subscription',
        });
        continue;
      }

      await stripeClient.billing.meterEvents.create({
        event_name: 'credential_verification',
        payload: {
          stripe_customer_id: meteredItem.id,
          value: String(totalUsage),
        },
        timestamp: Math.floor(now.getTime() / 1000),
      });

      results.push({
        org_id: orgId,
        total_usage: totalUsage,
        reported_to_stripe: true,
        stripe_subscription_item_id: meteredItem.id,
      });

      logger.info({ orgId, totalUsage, itemId: meteredItem.id }, 'Metered usage reported to Stripe');
    } catch (err) {
      logger.error({ error: err, orgId }, 'Failed to report metered usage to Stripe');
      results.push({
        org_id: orgId,
        total_usage: totalUsage,
        reported_to_stripe: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  return results;
}
