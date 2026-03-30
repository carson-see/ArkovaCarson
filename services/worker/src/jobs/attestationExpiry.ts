/**
 * Attestation Expiry Monitoring (ATT-08)
 *
 * Checks for attestations approaching expiry (30 days, 7 days, on expiry).
 * Fires webhook events: attestation.expiring, attestation.expired
 * Runs daily via cron.
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

interface ExpiryResult {
  checked: number;
  expiring_30d: number;
  expiring_7d: number;
  newly_expired: number;
  webhooks_queued: number;
}

export async function checkAttestationExpiry(): Promise<ExpiryResult> {
  const result: ExpiryResult = {
    checked: 0,
    expiring_30d: 0,
    expiring_7d: 0,
    newly_expired: 0,
    webhooks_queued: 0,
  };

  try {
    const now = new Date();
    const _in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    // Find ACTIVE attestations expiring within 30 days
    const { data: expiringAttestations, error } = await dbAny
      .from('attestations')
      .select('id, public_id, attestation_type, subject_identifier, attester_name, attester_org_id, expires_at, status')
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

      let eventType: string | null = null;

      if (daysUntilExpiry <= 0) {
        // Should not happen (we filtered >= now) but handle edge case
        result.newly_expired++;
        eventType = 'attestation.expired';
      } else if (daysUntilExpiry <= 7) {
        result.expiring_7d++;
        eventType = 'attestation.expiring';
      } else if (daysUntilExpiry <= 30) {
        result.expiring_30d++;
        eventType = 'attestation.expiring';
      }

      if (eventType && att.attester_org_id) {
        // Queue webhook event for the attester's org
        try {
          await dbAny.from('webhook_events').insert({
            org_id: att.attester_org_id,
            event_type: eventType,
            payload: {
              public_id: att.public_id,
              attestation_type: att.attestation_type,
              subject_identifier: att.subject_identifier,
              attester_name: att.attester_name,
              expires_at: att.expires_at,
              days_until_expiry: daysUntilExpiry,
            },
          });
          result.webhooks_queued++;
        } catch (webhookError) {
          logger.warn({ error: webhookError, publicId: att.public_id }, 'Failed to queue expiry webhook');
        }
      }
    }

    // Also find attestations that just expired (status still ACTIVE but expires_at < now)
    const { data: justExpired, error: expiredError } = await dbAny
      .from('attestations')
      .select('id, public_id, attestation_type, subject_identifier, attester_name, attester_org_id, expires_at')
      .eq('status', 'ACTIVE')
      .not('expires_at', 'is', null)
      .lt('expires_at', now.toISOString());

    if (!expiredError && justExpired?.length) {
      result.newly_expired += justExpired.length;

      for (const att of justExpired) {
        // Update status to EXPIRED
        await dbAny
          .from('attestations')
          .update({ status: 'EXPIRED' })
          .eq('id', att.id);

        // Queue expired webhook event
        if (att.attester_org_id) {
          try {
            await dbAny.from('webhook_events').insert({
              org_id: att.attester_org_id,
              event_type: 'attestation.expired',
              payload: {
                public_id: att.public_id,
                attestation_type: att.attestation_type,
                subject_identifier: att.subject_identifier,
                attester_name: att.attester_name,
                expires_at: att.expires_at,
              },
            });
            result.webhooks_queued++;
          } catch (webhookError) {
            logger.warn({ error: webhookError, publicId: att.public_id }, 'Failed to queue expired webhook');
          }
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
