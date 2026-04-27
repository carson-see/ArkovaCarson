/**
 * Client-side audit event logging
 *
 * Posts to the worker /api/audit/event endpoint. The worker validates,
 * forces actor_id from the JWT, and inserts as service_role — keeping the
 * audit trail unforgeable by the actor it records (CLAUDE.md §1.4).
 *
 * Migration 0276 (SCRUM-1270) REVOKEd INSERT on audit_events from
 * authenticated/anon, so direct supabase.from('audit_events').insert() is
 * no longer allowed.
 *
 * Server-side RPC functions (revoke_anchor, bulk_create_anchors,
 * complete_onboarding, invite_member) handle their own audit logging
 * internally via service_role.
 *
 * Fire-and-forget — failures must not block the user flow.
 */

import { supabase } from '@/lib/supabase';
import { WORKER_URL } from '@/lib/workerClient';
import type { AuditEventCategory } from '@/lib/validators';

interface AuditEventParams {
  eventType: string;
  eventCategory: AuditEventCategory;
  targetType?: string;
  targetId?: string;
  orgId?: string | null;
  details?: string;
}

export async function logAuditEvent({
  eventType,
  eventCategory,
  targetType,
  targetId,
  orgId,
  details,
}: AuditEventParams): Promise<void> {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
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
    });
  } catch {
    // Fire-and-forget — audit failures must never block the user flow
  }
}
