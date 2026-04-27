/**
 * SCRUM-1270 (R2-7) — append-only audit_events writer.
 *
 * Browser callers write through this endpoint instead of inserting directly.
 * The browser's anon JWT is verified, then the row is written via service_role.
 * `actor_id` is forced to the JWT's `sub` so callers cannot impersonate other
 * users by spoofing the body. RLS for browser writes is dropped in 0276.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

const AUDIT_EVENT_CATEGORIES = ['AUTH', 'ANCHOR', 'PROFILE', 'ORG', 'ADMIN', 'SYSTEM'] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const auditEventBodySchema = z
  .object({
    event_type: z.string().min(1).max(120),
    event_category: z.enum(AUDIT_EVENT_CATEGORIES),
    target_type: z.string().min(1).max(60).nullable().optional(),
    target_id: z.string().min(1).max(120).nullable().optional(),
    org_id: z.string().regex(UUID_RE, 'org_id must be a UUID').nullable().optional(),
    details: z.string().max(4000).nullable().optional(),
  })
  .strict();

export type AuditEventBody = z.infer<typeof auditEventBodySchema>;

export const auditEventRouter = Router();

auditEventRouter.post('/event', async (req: Request, res: Response) => {
  // requireAuth has already verified the JWT and attached userId.
  const userId = (req as Request & { userId?: string }).userId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const parsed = auditEventBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'audit event body failed validation',
      details: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
    });
    return;
  }
  const body = parsed.data;

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
    logger.error({ err: error.message, event_type: body.event_type }, 'audit_event_insert_failed');
    res.status(500).json({ error: 'audit_event_insert_failed' });
    return;
  }

  res.status(202).json({ status: 'accepted' });
});
