/**
 * Client-side audit event logging.
 *
 * Posts to worker /api/audit/event — actor_id forced from JWT, inserted as
 * service_role. Migration 0276 (SCRUM-1270) blocks browser inserts.
 * Fire-and-forget — failures must never block the user flow.
 */

import { workerFetch } from '@/lib/workerClient';
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
    await workerFetch(
      '/api/audit/event',
      {
        method: 'POST',
        body: JSON.stringify({
          event_type: eventType,
          event_category: eventCategory,
          target_type: targetType ?? null,
          target_id: targetId ?? null,
          org_id: orgId ?? null,
          details: details ?? null,
        }),
      },
      5_000,
    );
  } catch {
    // Fire-and-forget — audit failures must never block the user flow
  }
}
