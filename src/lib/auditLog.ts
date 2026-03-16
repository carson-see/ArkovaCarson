/**
 * Client-side audit event logging
 *
 * Provides a thin helper for inserting audit events from React components.
 * Fire-and-forget — failures are logged to console but never block the caller.
 *
 * Server-side RPC functions (revoke_anchor, bulk_create_anchors, complete_onboarding,
 * invite_member) handle their own audit logging internally.
 *
 * @see P1-TS-06
 */

import { supabase } from '@/lib/supabase';
import type { AuditEventCategory } from '@/lib/validators';

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
    const {
      data: { user },
    } = await supabase.auth.getUser();

    // GDPR Art. 5(1)(c): Never store actor_email in audit_events.
    // actor_id UUID is sufficient; email can be looked up via JOIN when needed.
    await supabase.from('audit_events').insert({
      event_type: eventType,
      event_category: eventCategory,
      actor_id: user?.id ?? null,
      target_type: targetType ?? null,
      target_id: targetId ?? null,
      org_id: orgId ?? null,
      details: details ?? null,
    });
  } catch {
    // Fire-and-forget — audit failures must never block the user flow
  }
}
