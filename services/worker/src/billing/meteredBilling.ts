/* eslint-disable arkova/missing-org-filter -- cross-org cron: metered billing batch processes all active subscriptions */
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

interface OrgCreditMeteringRow {
  org_id: string;
  is_test: boolean | null;
}

interface OrgCreditMeteringError {
  message?: string;
}

interface OrgCreditMeteringQuery {
  select(columns: 'org_id, is_test'): {
    in(column: 'org_id', values: string[]): Promise<{
      data: OrgCreditMeteringRow[] | null;
      error: OrgCreditMeteringError | null;
    }>;
  };
}

function orgCreditsForMetering(): OrgCreditMeteringQuery {
  // The live schema includes org_credits, but the generated worker DB types
  // lag it. Keep the cast local so sandbox billing remains fail-closed.
  return (db.from as unknown as (relation: 'org_credits') => OrgCreditMeteringQuery)('org_credits');
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

  // SCRUM-1740 AC4: load org_credits.is_test for every org with an active
  // subscription so we can skip sandbox orgs at meter-event time. Sandbox
  // orgs (is_test=true) must NEVER have a Stripe meter event fired against
  // them — they're partner test pools, not billable usage. The
  // SCRUM-1739 spec contract pins this.
  const orgIds = Array.from(new Set(subs.map((s) => s.org_id).filter((id): id is string => Boolean(id))));
  const testOrgIds = new Set<string>();
  if (orgIds.length > 0) {
    const { data: creditRows, error: creditErr } = await orgCreditsForMetering()
      .select('org_id, is_test')
      .in('org_id', orgIds);
    if (creditErr) {
      // Fail-CLOSED: if we can't tell which orgs are test, skip the whole
      // report rather than risk billing a partner sandbox. The cron will
      // retry next cycle.
      logger.error({ err: creditErr.message ?? String(creditErr) }, 'Failed to load org_credits.is_test for meter-exclusion check; aborting reportMeteredUsageToStripe to avoid billing sandbox orgs');
      return results;
    }
    for (const row of creditRows ?? []) {
      if (row.is_test === true) testOrgIds.add(row.org_id);
    }
  }

  for (const sub of subs) {
    const orgId = sub.org_id;
    if (!orgId) continue;

    // SCRUM-1740 AC4: skip sandbox orgs entirely — record the skip in
    // results so callers / observability can verify the meter-exclusion
    // path fired.
    if (testOrgIds.has(orgId)) {
      logger.info({ orgId, planId: sub.plan_id }, 'metered_usage_excluded_test_org');
      results.push({ org_id: orgId, total_usage: 0, reported_to_stripe: false, error: 'sandbox_excluded' });
      continue;
    }

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

      // Retrieve subscription to get the customer ID for meter events
      const subscription = await stripeClient.subscriptions.retrieve(sub.stripe_subscription_id!);
      const customerId = typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer.id;

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
          stripe_customer_id: customerId,
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
