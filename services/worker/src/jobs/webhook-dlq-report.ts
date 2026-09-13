/**
 * Inbound Webhook DLQ — Report Job (SCRUM-4514)
 *
 * Cloud Scheduler-compatible companion to the operator drain in
 * `api/admin-webhook-dlq.ts`. This job does NOT replay or resolve anything —
 * it only counts. Its entire job is to make a non-empty, silently-growing
 * `webhook_dlq` backlog visible in logs/Sentry between operator drain runs,
 * per the "drained by nobody" gap this ticket exists to close (see
 * api/v1/webhooks/agents.md).
 *
 * Bounded, no PII: counts and a single oldest-age number, by provider. Never
 * `reason`, `payload_hash`, `external_id`, or `webhook_id` — those can carry
 * upstream-derived identifiers and are out of scope for a log line per §1.6A.
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

export interface WebhookDlqReportResult {
  total_unresolved: number;
  by_provider: Record<string, { count: number; oldest_age_seconds: number }>;
}

export async function runWebhookDlqReport(): Promise<WebhookDlqReportResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- webhook_dlq predates strict Supabase typing on this path (matches the three writers + admin-webhook-dlq.ts)
  const { data, error } = await (db as any)
    .from('webhook_dlq')
    .select('provider, created_at')
    .is('resolved_at', null);

  if (error) {
    logger.error({ error }, 'webhook-dlq-report query failed');
    throw new Error('webhook_dlq report query failed');
  }

  const rows = (data ?? []) as Array<{ provider: string; created_at: string }>;
  const now = Date.now();
  const byProvider: Record<string, { count: number; oldest_age_seconds: number }> = {};

  for (const row of rows) {
    const ageSeconds = Math.max(0, Math.floor((now - new Date(row.created_at).getTime()) / 1000));
    const bucket = byProvider[row.provider] ?? { count: 0, oldest_age_seconds: 0 };
    bucket.count += 1;
    bucket.oldest_age_seconds = Math.max(bucket.oldest_age_seconds, ageSeconds);
    byProvider[row.provider] = bucket;
  }

  const result: WebhookDlqReportResult = {
    total_unresolved: rows.length,
    by_provider: byProvider,
  };

  if (result.total_unresolved > 0) {
    // Visible signal even when nobody is looking at the admin endpoint.
    logger.warn(result, 'webhook_dlq has unresolved rows — operator drain has not caught up');
  } else {
    logger.info(result, 'webhook_dlq report: clean');
  }

  return result;
}
