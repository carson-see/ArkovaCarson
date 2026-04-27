/**
 * Client-side audit event logging
 *
 * SCRUM-1270 (R2-7): browser callers no longer insert into audit_events directly.
 * Migration 0277 dropped the authenticated INSERT policy so that the audit log
 * cannot be forged by the actor it records (Forensic 7 / SOC-2 CC7.2). All
 * writes go through POST /api/audit/event, which inserts as service_role and
 * pins actor_id to the JWT subject.
 *
 * PII-01 / GDPR Art. 5(1)(c) data minimization: this client never sends
 * actor_email — only the JWT bearer token is included, and the worker derives
 * actor_id from auth.uid() server-side. The audit_events row never carries the
 * email column on writes from this path.
 *
 * Server-side RPC functions (revoke_anchor, bulk_create_anchors, complete_onboarding,
 * invite_member) handle their own audit logging internally and are unaffected.
 */

import { WORKER_URL } from './workerClient';
import { supabase } from './supabase';
import type { AuditEventCategory } from './validators';

interface AuditEventParams {
  eventType: string;
  eventCategory: AuditEventCategory;
  targetType?: string;
  targetId?: string;
  orgId?: string | null;
  details?: string;
}

/**
 * Log an audit event. Fire-and-forget — never throws.
 * Server-side service_role insert via POST /api/audit/event.
 */
export async function logAuditEvent({
  eventType,
  eventCategory,
  targetType,
  targetId,
  orgId,
  details,
}: AuditEventParams): Promise<void> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;

    await fetch(`${WORKER_URL}/api/audit/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        event_type: eventType,
        event_category: eventCategory,
        target_type: targetType ?? null,
        target_id: targetId ?? null,
        org_id: orgId ?? null,
        details: details ?? null,
      }),
      keepalive: true,
    });
  } catch {
    // Fire-and-forget — audit failures must never block the user flow.
  }
}
