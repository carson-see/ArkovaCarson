/**
 * Workspace Subscription Renewal (SCRUM-1147)
 *
 * Google Drive `changes.watch` channels and Microsoft Graph subscriptions
 * both expire (Drive: ~7 days, Graph: ~3 days) and stop delivering events
 * once expired. This job sweeps `connector_subscriptions` for rows whose
 * `expires_at` falls inside RENEWAL_WINDOW_MS, asks the vendor for a fresh
 * channel/subscription, and writes the new `expires_at` + `last_renewed_at`.
 *
 * Failure path: row is flipped to `status='degraded'` with a human-readable
 * `last_renewal_error`. The connector wizard / health dashboard
 * (SCRUM-1146) reads those fields to surface "vendor auth expired" without
 * silently dropping events.
 *
 * Network calls are injected so tests can run without real Google /
 * Microsoft credentials. Production wiring lives in `routes/cron.ts`.
 */
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

export const RENEWAL_WINDOW_MS = 6 * 60 * 60 * 1000;
const RENEWAL_BATCH_SIZE = 100;
// Avoid 100-way fanout on outbound vendor renewals — a misconfigured /
// throttling vendor would otherwise saturate the Cloud Run instance's
// socket pool and look like an outage.
const RENEWAL_CONCURRENCY = 5;

export interface SubscriptionRenewalResult {
  vendor_subscription_id: string;
  expires_at: string;
}

export interface SubscriptionRenewalDeps {
  driveRenew: (sub: SubscriptionRow) => Promise<SubscriptionRenewalResult>;
  graphRenew: (sub: SubscriptionRow) => Promise<SubscriptionRenewalResult>;
}

export interface SubscriptionRenewalPassResult {
  checked: number;
  renewed: number;
  failed: number;
}

export type WorkspaceSubscriptionProvider = 'google_drive' | 'microsoft_graph';

interface SubscriptionRow {
  id: string;
  provider: WorkspaceSubscriptionProvider;
  org_id: string;
  vendor_subscription_id: string;
  expires_at: string;
  status: string;
  last_renewed_at: string | null;
  last_renewal_error: string | null;
}

async function fetchExpiringRows(): Promise<SubscriptionRow[]> {
  const cutoff = new Date(Date.now() + RENEWAL_WINDOW_MS).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('connector_subscriptions')
    .select(
      'id, provider, org_id, vendor_subscription_id, expires_at, status, last_renewed_at, last_renewal_error',
    )
    .or(`status.eq.active,status.eq.degraded`)
    .order('expires_at', { ascending: true })
    .limit(RENEWAL_BATCH_SIZE);
  if (error) {
    logger.warn({ error }, 'subscription renewal: candidate fetch failed');
    return [];
  }
  // The `.or` filter narrows to active/degraded; we then filter expiry in
  // memory since Supabase v2's `.or` does not chain cleanly with `.lte`.
  // The batch is bounded at 100 so this is cheap.
  return ((data as SubscriptionRow[] | null) ?? []).filter(
    (r) => r.expires_at <= cutoff,
  );
}

async function persistRenewalSuccess(
  sub: SubscriptionRow,
  result: SubscriptionRenewalResult,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (db as any)
    .from('connector_subscriptions')
    .update({
      vendor_subscription_id: result.vendor_subscription_id,
      expires_at: result.expires_at,
      status: 'active',
      last_renewed_at: new Date().toISOString(),
      last_renewal_error: null,
    })
    .eq('id', sub.id);
  if (error) {
    logger.error({ error, subscriptionId: sub.id }, 'subscription renewal: success write failed');
  }
}

async function persistRenewalFailure(sub: SubscriptionRow, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (db as any)
    .from('connector_subscriptions')
    .update({
      status: 'degraded',
      last_renewal_error: message.slice(0, 1000),
    })
    .eq('id', sub.id);
  if (error) {
    logger.error({ error, subscriptionId: sub.id }, 'subscription renewal: failure write failed');
  }
}

async function renewOne(
  sub: SubscriptionRow,
  deps: SubscriptionRenewalDeps,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  try {
    const renew = sub.provider === 'google_drive' ? deps.driveRenew : deps.graphRenew;
    const result = await renew(sub);
    await persistRenewalSuccess(sub, result);
    return { ok: true };
  } catch (err) {
    logger.warn(
      { error: err, subscriptionId: sub.id, provider: sub.provider },
      'subscription renewal: vendor call failed',
    );
    await persistRenewalFailure(sub, err);
    return { ok: false, error: err };
  }
}

export async function runSubscriptionRenewal(
  deps: SubscriptionRenewalDeps,
): Promise<SubscriptionRenewalPassResult> {
  const result: SubscriptionRenewalPassResult = { checked: 0, renewed: 0, failed: 0 };
  if (process.env.ENABLE_WORKSPACE_RENEWAL === 'false') {
    logger.info('Workspace subscription renewal disabled via ENABLE_WORKSPACE_RENEWAL=false');
    return result;
  }
  const rows = await fetchExpiringRows();
  if (rows.length === 0) return result;
  result.checked = rows.length;

  let cursor = 0;
  const next = async (): Promise<void> => {
    while (cursor < rows.length) {
      const idx = cursor++;
      const outcome = await renewOne(rows[idx], deps);
      if (outcome.ok) result.renewed += 1;
      else result.failed += 1;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(RENEWAL_CONCURRENCY, rows.length) }, () => next()),
  );

  logger.info(
    { checked: result.checked, renewed: result.renewed, failed: result.failed },
    'Workspace subscription renewal pass complete',
  );
  return result;
}
