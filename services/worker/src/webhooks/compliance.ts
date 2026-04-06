/**
 * Compliance Event Webhooks (COMP-08)
 *
 * Emits compliance-specific webhook events for GRC platform integration.
 * Event types:
 *   - compliance.certificate_expiring (30d, 7d, 1d)
 *   - compliance.anchor_delayed (>1h batch idle)
 *   - compliance.signature_revoked
 *   - compliance.score_degraded
 *   - compliance.timestamp_coverage_low
 *
 * Reuses existing webhook delivery infrastructure (dispatchWebhookEvent).
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { dispatchWebhookEvent } from './delivery.js';
import crypto from 'node:crypto';

/**
 * Check for expiring certificates and emit webhook events.
 * Called by cron job. Fires at 30-day, 7-day, and 1-day thresholds.
 */
export async function checkCertificateExpiry(): Promise<number> {
  let eventsEmitted = 0;
  const thresholds = [
    { days: 30, label: '30_day' },
    { days: 7, label: '7_day' },
    { days: 1, label: '1_day' },
  ];

  for (const threshold of thresholds) {
    const futureDate = new Date();
    futureDate.setUTCDate(futureDate.getUTCDate() + threshold.days);
    const windowStart = new Date(futureDate);
    windowStart.setUTCDate(windowStart.getUTCDate() - 1);

    try {
      const { data: certs } = await db
        .from('signing_certificates')
        .select('id, org_id, subject_cn, not_after')
        .gt('not_after', windowStart.toISOString())
        .lte('not_after', futureDate.toISOString());

      if (certs) {
        for (const cert of certs) {
          await dispatchWebhookEvent(
            cert.org_id,
            'compliance.certificate_expiring',
            crypto.randomUUID(),
            {
              certificate_id: cert.id,
              subject: cert.subject_cn,
              expires_at: cert.not_after,
              warning_level: threshold.label,
              days_remaining: threshold.days,
            },
          );
          eventsEmitted++;
        }
      }
    } catch (err) {
      logger.error({ error: err, threshold: threshold.label }, 'Certificate expiry check failed');
    }
  }

  return eventsEmitted;
}

/**
 * Check for delayed anchor batches and emit webhook events.
 * Fires when no batch has processed in >1 hour for an org with pending anchors.
 */
export async function checkAnchorDelays(): Promise<number> {
  let eventsEmitted = 0;
  const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();

  try {
    // Find orgs with PENDING anchors older than 1 hour
    const { data: staleAnchors } = await db
      .from('anchors')
      .select('org_id, created_at')
      .eq('status', 'PENDING')
      .lt('created_at', oneHourAgo)
      .is('deleted_at', null);

    if (!staleAnchors || staleAnchors.length === 0) return 0;

    // Group by org
    const orgMap = new Map<string, number>();
    for (const anchor of staleAnchors) {
      orgMap.set(anchor.org_id, (orgMap.get(anchor.org_id) || 0) + 1);
    }

    for (const [orgId, count] of orgMap) {
      await dispatchWebhookEvent(
        orgId,
        'compliance.anchor_delayed',
        crypto.randomUUID(),
        {
          pending_count: count,
          oldest_pending_since: staleAnchors
            .filter(a => a.org_id === orgId)
            .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())[0]
            ?.created_at,
          threshold_minutes: 60,
        },
      );
      eventsEmitted++;
    }
  } catch (err) {
    logger.error({ error: err }, 'Anchor delay check failed');
  }

  return eventsEmitted;
}

/**
 * Emit a signature revocation compliance event.
 * Called from the signature revocation endpoint.
 */
export async function emitSignatureRevoked(
  orgId: string,
  signatureId: string,
  reason: string,
): Promise<void> {
  try {
    await dispatchWebhookEvent(
      orgId,
      'compliance.signature_revoked',
      crypto.randomUUID(),
      {
        signature_id: signatureId,
        revocation_reason: reason,
        revoked_at: new Date().toISOString(),
      },
    );
  } catch (err) {
    logger.error({ error: err, signatureId }, 'Failed to emit signature revocation event');
  }
}

/**
 * Check timestamp coverage and emit event if below threshold.
 * Coverage below 80% triggers the event.
 */
export async function checkTimestampCoverage(): Promise<number> {
  let eventsEmitted = 0;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString();

  try {
    // Get all orgs with recent signatures
    const { data: orgSigs } = await db
      .from('signatures')
      .select('org_id')
      .gte('signed_at', thirtyDaysAgo);

    if (!orgSigs) return 0;

    const orgIds = [...new Set(orgSigs.map(s => s.org_id))];

    for (const orgId of orgIds) {
      const { count: totalSigs } = await db
        .from('signatures')
        .select('*', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .gte('signed_at', thirtyDaysAgo);

      const { count: timestampedSigs } = await db
        .from('timestamp_tokens')
        .select('*', { count: 'exact', head: true })
        .gte('tst_gen_time', thirtyDaysAgo);

      if (totalSigs && totalSigs > 0) {
        const coverage = Math.round(((timestampedSigs || 0) / totalSigs) * 100);
        if (coverage < 80) {
          await dispatchWebhookEvent(
            orgId,
            'compliance.timestamp_coverage_low',
            crypto.randomUUID(),
            {
              coverage_pct: coverage,
              threshold_pct: 80,
              total_signatures: totalSigs,
              timestamped_signatures: timestampedSigs || 0,
              period_days: 30,
            },
          );
          eventsEmitted++;
        }
      }
    }
  } catch (err) {
    logger.error({ error: err }, 'Timestamp coverage check failed');
  }

  return eventsEmitted;
}

/**
 * Run all compliance checks. Called from cron scheduler.
 */
export async function runComplianceChecks(): Promise<{
  certificate_expiry: number;
  anchor_delays: number;
  timestamp_coverage: number;
}> {
  const [certEvents, anchorEvents, tsEvents] = await Promise.all([
    checkCertificateExpiry(),
    checkAnchorDelays(),
    checkTimestampCoverage(),
  ]);

  logger.info({
    certificate_expiry: certEvents,
    anchor_delays: anchorEvents,
    timestamp_coverage: tsEvents,
  }, 'Compliance webhook checks complete');

  return {
    certificate_expiry: certEvents,
    anchor_delays: anchorEvents,
    timestamp_coverage: tsEvents,
  };
}
