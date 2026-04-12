/**
 * HIPAA Audit Report API — REG-07 (SCRUM-566)
 *
 * GET  /api/v1/hipaa/audit         — List healthcare credential access events
 * GET  /api/v1/hipaa/audit/export  — Export as CSV
 *
 * Section 164.312(b): Audit controls — record and examine activity.
 * Filters audit_events to healthcare credential types only.
 * Accessible to ORG_ADMIN and PLATFORM_ADMIN roles only.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

export const hipaaAuditRouter = Router();

const HEALTHCARE_TYPES = ['INSURANCE', 'MEDICAL', 'MEDICAL_LICENSE', 'IMMUNIZATION'];

const AuditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
  action: z.string().optional(),
  user_id: z.string().uuid().optional(),
});

// ─── GET /api/v1/hipaa/audit ────────────────────────────────────────────────

hipaaAuditRouter.get('/', async (req: Request, res: Response) => {
  try {
    const orgId = req.headers['x-org-id'] as string;
    if (!orgId) {
      res.status(400).json({ error: 'x-org-id header required' });
      return;
    }

    const parsed = AuditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }

    const { page, limit, from_date, to_date, action, user_id } = parsed.data;
    const offset = (page - 1) * limit;

    let query = dbAny
      .from('audit_events')
      .select('*', { count: 'exact' })
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (from_date) query = query.gte('created_at', from_date);
    if (to_date) query = query.lte('created_at', to_date);
    if (action) query = query.eq('event_type', action);
    if (user_id) query = query.eq('actor_id', user_id);

    const { data, error, count } = await query;

    if (error) {
      logger.error({ error }, 'Failed to query HIPAA audit events');
      res.status(500).json({ error: 'Failed to query audit events' });
      return;
    }

    // Filter to healthcare credential types (post-query filter on details JSON)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const healthcareEvents = (data ?? []).filter((event: any) => {
      try {
        const details = typeof event.details === 'string' ? JSON.parse(event.details) : event.details;
        return details?.credential_type && HEALTHCARE_TYPES.includes(details.credential_type);
      } catch {
        return false;
      }
    });

    res.json({
      events: healthcareEvents,
      total: count ?? 0,
      healthcare_count: healthcareEvents.length,
      page,
      limit,
    });
  } catch (err) {
    logger.error({ err }, 'HIPAA audit query error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/v1/hipaa/audit/export ─────────────────────────────────────────

hipaaAuditRouter.get('/export', async (req: Request, res: Response) => {
  try {
    const orgId = req.headers['x-org-id'] as string;
    if (!orgId) {
      res.status(400).json({ error: 'x-org-id header required' });
      return;
    }

    const from_date = req.query.from_date as string | undefined;
    const to_date = req.query.to_date as string | undefined;
    const MAX_EXPORT_ROWS = 10000;

    let query = dbAny
      .from('audit_events')
      .select('*')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(MAX_EXPORT_ROWS);

    if (from_date) query = query.gte('created_at', from_date);
    if (to_date) query = query.lte('created_at', to_date);

    const { data, error } = await query;

    if (error) {
      logger.error({ error }, 'Failed to export HIPAA audit events');
      res.status(500).json({ error: 'Failed to export audit events' });
      return;
    }

    // Filter to healthcare events
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events = (data ?? []).filter((event: any) => {
      try {
        const details = typeof event.details === 'string' ? JSON.parse(event.details) : event.details;
        return details?.credential_type && HEALTHCARE_TYPES.includes(details.credential_type);
      } catch {
        return false;
      }
    });

    const headers = ['Timestamp', 'Event Type', 'Actor ID', 'Target Type', 'Target ID', 'Credential Type', 'Details'];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = events.map((e: any) => {
      const details = typeof e.details === 'string' ? JSON.parse(e.details) : (e.details ?? {});
      return [
        e.created_at,
        e.event_type,
        e.actor_id ?? '',
        e.target_type ?? '',
        e.target_id ?? '',
        details.credential_type ?? '',
        JSON.stringify(details),
      ];
    });

    const csvContent = [
      headers.join(','),
      ...rows.map((row: string[]) =>
        row.map((cell: string) => `"${String(cell).replace(/"/g, '""')}"`).join(','),
      ),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="hipaa-audit-${orgId}.csv"`);
    res.send(csvContent);
  } catch (err) {
    logger.error({ err }, 'HIPAA audit export error');
    res.status(500).json({ error: 'Internal server error' });
  }
});
