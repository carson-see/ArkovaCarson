/**
 * Compliance Event Emitters (COMP-08)
 *
 * Defines compliance-specific webhook event types and emitter functions.
 * These fire to registered webhook endpoints when compliance-relevant
 * conditions are detected (certificate expiry, anchor delay, etc.).
 *
 * Integrates with existing webhook infrastructure (WEBHOOK-1 through WEBHOOK-4).
 */

import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

// ─── Event Types ───────────────────────────────────────────────────────

export const COMPLIANCE_EVENT_TYPES = [
  'compliance.certificate_expiring',
  'compliance.certificate_expired',
  'compliance.anchor_delayed',
  'compliance.signature_revoked',
  'compliance.score_degraded',
  'compliance.timestamp_coverage_low',
] as const;

export type ComplianceEventType = typeof COMPLIANCE_EVENT_TYPES[number];

interface ComplianceEvent {
  event_type: ComplianceEventType;
  org_id: string;
  data: Record<string, unknown>;
  severity: 'info' | 'warning' | 'critical';
}

// ─── Emitters ──────────────────────────────────────────────────────────

/**
 * Check for expiring certificates and emit events.
 * Intended to be called by a cron job (e.g., daily).
 */
export async function checkCertificateExpiry(orgId: string): Promise<ComplianceEvent[]> {
  const events: ComplianceEvent[] = [];
  const now = new Date();

  const { data: certs } = await (db as any)
    .from('signing_certificates')
    .select('id, subject_cn, not_after, status')
    .eq('org_id', orgId)
    .eq('status', 'ACTIVE');

  if (!certs) return events;

  for (const cert of certs) {
    const expiresAt = new Date(cert.not_after);
    const daysUntil = Math.ceil((expiresAt.getTime() - now.getTime()) / (24 * 3600_000));

    if (daysUntil <= 0) {
      events.push({
        event_type: 'compliance.certificate_expired',
        org_id: orgId,
        severity: 'critical',
        data: { certificate_cn: cert.subject_cn, expired_at: cert.not_after },
      });
    } else if (daysUntil <= 7) {
      events.push({
        event_type: 'compliance.certificate_expiring',
        org_id: orgId,
        severity: 'critical',
        data: { certificate_cn: cert.subject_cn, expires_at: cert.not_after, days_remaining: daysUntil },
      });
    } else if (daysUntil <= 30) {
      events.push({
        event_type: 'compliance.certificate_expiring',
        org_id: orgId,
        severity: 'warning',
        data: { certificate_cn: cert.subject_cn, expires_at: cert.not_after, days_remaining: daysUntil },
      });
    }
  }

  return events;
}

/**
 * Check for delayed anchors (submitted but not confirmed in >1h).
 */
export async function checkAnchorDelays(orgId: string): Promise<ComplianceEvent[]> {
  const events: ComplianceEvent[] = [];
  const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();

  const { data: stale } = await db
    .from('anchors')
    .select('public_id, submitted_at')
    .eq('org_id', orgId)
    .eq('status', 'SUBMITTED')
    .lt('submitted_at', oneHourAgo)
    .is('deleted_at', null);

  if (stale && stale.length > 0) {
    events.push({
      event_type: 'compliance.anchor_delayed',
      org_id: orgId,
      severity: 'warning',
      data: {
        delayed_count: stale.length,
        oldest_submission: stale[0].submitted_at,
        public_ids: stale.slice(0, 10).map(a => a.public_id),
      },
    });
  }

  return events;
}

/**
 * Emit a signature revocation event (called inline when a signature is revoked).
 */
export function buildSignatureRevokedEvent(
  orgId: string,
  signaturePublicId: string,
  reason: string,
): ComplianceEvent {
  return {
    event_type: 'compliance.signature_revoked',
    org_id: orgId,
    severity: 'warning',
    data: { signature_id: signaturePublicId, reason },
  };
}

/**
 * Fire compliance events to registered webhook endpoints.
 */
export async function fireComplianceEvents(events: ComplianceEvent[]): Promise<void> {
  if (events.length === 0) return;

  for (const event of events) {
    // Log to audit_events (correct column names per migration 0006)
    await db.from('audit_events').insert({
      event_type: event.event_type,
      event_category: 'SYSTEM',
      org_id: event.org_id,
      details: JSON.stringify({ severity: event.severity, ...event.data }),
    }).then(() => {}, (err: unknown) => {
      logger.error('Failed to log compliance event', { error: err, event_type: event.event_type });
    });

    // Dispatch to webhook endpoints (reuse existing infrastructure)
    try {
      const { data: endpoints } = await db
        .from('webhook_endpoints')
        .select('id, url')
        .eq('org_id', event.org_id)
        .eq('is_active', true);

      if (endpoints) {
        for (const ep of endpoints) {
          // Queue webhook delivery via webhook_delivery_logs (migration 0018)
          void db.from('webhook_delivery_logs').insert({
            endpoint_id: ep.id,
            event_type: event.event_type,
            event_id: crypto.randomUUID(),
            payload: event.data,
            status: 'pending',
          }).then(() => {}, () => {});
        }
      }
    } catch (err) {
      logger.error('Failed to dispatch compliance webhook', {
        error: err instanceof Error ? err.message : String(err),
        event_type: event.event_type,
      });
    }
  }

  logger.info('Compliance events fired', {
    count: events.length,
    types: [...new Set(events.map(e => e.event_type))],
  });
}

/**
 * Run all compliance checks for an org (intended for cron).
 */
export async function runComplianceChecks(orgId: string): Promise<void> {
  const events = [
    ...await checkCertificateExpiry(orgId),
    ...await checkAnchorDelays(orgId),
  ];
  await fireComplianceEvents(events);
}
