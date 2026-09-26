/**
 * Attestation Expiry Monitoring (ATT-08)
 *
 * Checks for attestations approaching expiry (30 days, 7 days) and flips
 * status to EXPIRED once `expires_at` has passed. Runs daily via cron
 * (`POST /check-attestation-expiry`).
 *
 * SCRUM-webhook-event-divergence: this job used to ALSO queue
 * `attestation.expiring` / `attestation.expired` webhook events by inserting
 * directly into a `webhook_events` table. That table does not exist anywhere
 * in `supabase/migrations` or the generated `database.types.ts` — every
 * insert failed at runtime (`relation "public.webhook_events" does not
 * exist`), so the events were never queued, let alone delivered. Neither
 * event type was ever registered in `PAYLOAD_SCHEMAS_BY_EVENT_TYPE` either
 * (`services/worker/src/webhooks/payload-schemas.ts`), so no org could have
 * subscribed to them even if the insert had succeeded.
 *
 * Worse, the ordering guarantee the old code carried — "insert webhooks
 * BEFORE updating status; skip the status update if the insert fails" —
 * meant that for every attestation with an `attester_org_id`, the daily
 * insert-into-nonexistent-table failure silently blocked the `EXPIRED` status
 * transition forever. This job likely never actually expired an
 * org-attributed attestation in any environment where the table was absent.
 *
 * Removed entirely rather than fixed forward: nothing subscribes, nothing
 * consumes a `webhook_events` table, and no UI/docs ever promised either
 * event (confirmed by full-repo search before this change). If attestation
 * expiry webhooks are wanted later, they should be added as a real,
 * `dispatchWebhookEvent` call site with a registered payload schema — see
 * `webhooks/compliance.ts` for the pattern — not resurrected here.
 * `check-webhook-event-emission-registration.ts` now fails CI if a future
 * emitter repeats this pattern (queues an event type absent from the
 * canonical map).
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { chunkForInFilter } from '../utils/postgrest-filter.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

interface ExpiryResult {
  checked: number;
  expiring_30d: number;
  expiring_7d: number;
  newly_expired: number;
}

export async function checkAttestationExpiry(): Promise<ExpiryResult> {
  const result: ExpiryResult = {
    checked: 0,
    expiring_30d: 0,
    expiring_7d: 0,
    newly_expired: 0,
  };

  try {
    const now = new Date();
    const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    // Find ACTIVE attestations expiring within 30 days (counters only — no
    // webhook is fired for this job; see file header).
    const { data: expiringAttestations, error } = await dbAny
      .from('attestations')
      .select('id, expires_at')
      .eq('status', 'ACTIVE')
      .not('expires_at', 'is', null)
      .lte('expires_at', in30Days.toISOString())
      .gte('expires_at', now.toISOString());

    if (error) {
      logger.error({ error }, 'Failed to query expiring attestations');
      return result;
    }

    result.checked = expiringAttestations?.length ?? 0;

    for (const att of (expiringAttestations ?? [])) {
      const expiresAt = new Date(att.expires_at);
      const daysUntilExpiry = Math.ceil((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

      if (daysUntilExpiry <= 7) {
        result.expiring_7d++;
      } else if (daysUntilExpiry <= 30) {
        result.expiring_30d++;
      }
    }

    // Also find attestations that just expired (status still ACTIVE but expires_at < now)
    // and flip them to EXPIRED. Unconditional now — there is no webhook side
    // channel to gate on (see file header).
    const { data: justExpired, error: expiredError } = await dbAny
      .from('attestations')
      .select('id')
      .eq('status', 'ACTIVE')
      .not('expires_at', 'is', null)
      .lt('expires_at', now.toISOString());

    if (!expiredError && justExpired?.length) {
      result.newly_expired += justExpired.length;

      // Bulk status update in chunks of `POSTGREST_IN_FILTER_CHUNK` or smaller.
      const expiredIds = justExpired.map((att: { id: string }) => att.id);
      for (const { values: chunk } of chunkForInFilter(expiredIds)) {
        const { error: bulkUpdateErr } = await dbAny
          .from('attestations')
          .update({ status: 'EXPIRED' })
          .in('id', chunk);

        if (bulkUpdateErr) {
          logger.error({ error: bulkUpdateErr, count: chunk.length }, 'Failed to bulk-update expired attestations chunk');
        }
      }
    }

    logger.info(result, 'Attestation expiry check complete');
    return result;
  } catch (error) {
    logger.error({ error }, 'Attestation expiry check failed');
    throw error;
  }
}
