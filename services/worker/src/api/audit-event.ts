/**
 * Audit Event Endpoint — SCRUM-1270 (R2-7)
 *
 * POST /api/audit/event
 *
 * Worker-only write path for audit_events. Replaces the prior browser-side
 * `supabase.from('audit_events').insert()` pattern (src/lib/auditLog.ts and
 * src/hooks/useIdleTimeout.ts) which was forgeable by the actor it recorded
 * (RLS migration 0011 allowed `actor_id = auth.uid()` writes).
 *
 * Migration 0276 closes the policy + REVOKEs INSERT from authenticated/anon.
 * This route validates a Zod schema, forces `actor_id` from the JWT (NOT the
 * body), and inserts as service_role.
 */

import type { Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Logger } from '../utils/logger.js';

// Mirror src/lib/validators.ts — these are the categories actually in use
// across the codebase (greppable via `event_category: 'X'`).
const AUDIT_EVENT_CATEGORIES = [
  'AUTH',
  'ANCHOR',
  'PROFILE',
  'ORG',
  'ADMIN',
  'SYSTEM',
  'SECURITY',
  'AI',
  'COMPLIANCE',
  'NOTIFICATION',
  'PLATFORM',
  'USER',
  'WEBHOOK',
] as const;

export const auditEventBodySchema = z
  .object({
    event_type: z.string().min(1).max(128),
    event_category: z.enum(AUDIT_EVENT_CATEGORIES),
    target_type: z.string().min(1).max(64).nullish(),
    target_id: z.string().min(1).max(128).nullish(),
    org_id: z.string().uuid().nullish(),
    details: z.string().max(10_000).nullish(),
  })
  .strict();

export type AuditEventBody = z.infer<typeof auditEventBodySchema>;

export interface AuditEventDeps {
  db: SupabaseClient;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export async function handleAuditEvent(
  userId: string,
  deps: AuditEventDeps,
  req: Request,
  res: Response,
): Promise<void> {
  const { db, logger } = deps;

  const parsed = auditEventBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'audit event payload failed validation',
      details: parsed.error.errors.map((e) => ({
        path: e.path.join('.'),
        code: e.code,
        message: e.message,
      })),
    });
    return;
  }

  const body = parsed.data;

  // GDPR Art. 5(1)(c): never store actor_email; actor_id UUID is sufficient.
  // actor_id is forced from the verified JWT — body cannot override.
  const { error } = await db.from('audit_events').insert({
    event_type: body.event_type,
    event_category: body.event_category,
    actor_id: userId,
    target_type: body.target_type ?? null,
    target_id: body.target_id ?? null,
    org_id: body.org_id ?? null,
    details: body.details ?? null,
  });

  if (error) {
    logger.error(
      { userId, eventType: body.event_type, error: error.message },
      'audit event insert failed',
    );
    res.status(500).json({ error: 'audit_write_failed' });
    return;
  }

  res.status(204).end();
}
