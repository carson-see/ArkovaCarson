/**
 * FERPA Directory Information Opt-Out API — REG-02 (SCRUM-562)
 *
 * PATCH /api/v1/directory-opt-out/:publicId   — Toggle opt-out for a single anchor
 * POST  /api/v1/directory-opt-out/bulk        — Bulk import opt-out status via CSV-style payload
 * GET   /api/v1/directory-opt-out             — List opt-out status for org's education anchors
 */

import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const router = Router();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

// ─── Validation Schemas ──────────────────────────────────────────────────────

const ToggleOptOutSchema = z.object({
  opt_out: z.boolean(),
});

const BulkOptOutSchema = z.object({
  records: z.array(z.object({
    public_id: z.string().min(1),
    opt_out: z.boolean(),
  })).min(1).max(1000),
});

// ─── PATCH /api/v1/directory-opt-out/:publicId ──────────────────────────────

router.patch('/:publicId', async (req, res) => {
  try {
    const orgId = req.headers['x-org-id'] as string;
    if (!orgId) {
      res.status(400).json({ error: 'x-org-id header required' });
      return;
    }

    const parsed = ToggleOptOutSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }

    const { publicId } = req.params;
    const { opt_out } = parsed.data;

    const { data, error } = await dbAny
      .from('anchors')
      .update({ directory_info_opt_out: opt_out })
      .eq('public_id', publicId)
      .eq('org_id', orgId)
      .select('public_id, directory_info_opt_out')
      .single();

    if (error || !data) {
      res.status(404).json({ error: 'Record not found or not in your organization' });
      return;
    }

    // Audit log
    void dbAny.from('audit_events').insert({
      event_type: 'DIRECTORY_OPT_OUT_CHANGED',
      event_category: 'COMPLIANCE',
      target_type: 'anchor',
      target_id: publicId,
      org_id: orgId,
      details: JSON.stringify({ opt_out, public_id: publicId }),
    });

    logger.info({ publicId, orgId, optOut: opt_out }, 'Directory info opt-out updated');

    res.json({
      public_id: data.public_id,
      directory_info_opt_out: data.directory_info_opt_out,
    });
  } catch (err) {
    logger.error({ err }, 'Directory opt-out toggle error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/v1/directory-opt-out/bulk ────────────────────────────────────

router.post('/bulk', async (req, res) => {
  try {
    const orgId = req.headers['x-org-id'] as string;
    if (!orgId) {
      res.status(400).json({ error: 'x-org-id header required' });
      return;
    }

    const parsed = BulkOptOutSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }

    const { records } = parsed.data;
    const results: { public_id: string; updated: boolean; error?: string }[] = [];

    for (const record of records) {
      const { data, error } = await dbAny
        .from('anchors')
        .update({ directory_info_opt_out: record.opt_out })
        .eq('public_id', record.public_id)
        .eq('org_id', orgId)
        .select('public_id')
        .single();

      if (error || !data) {
        results.push({ public_id: record.public_id, updated: false, error: 'Not found' });
      } else {
        results.push({ public_id: record.public_id, updated: true });
      }
    }

    const updatedCount = results.filter(r => r.updated).length;

    // Bulk audit log
    void dbAny.from('audit_events').insert({
      event_type: 'DIRECTORY_OPT_OUT_BULK_UPDATE',
      event_category: 'COMPLIANCE',
      target_type: 'organization',
      target_id: orgId,
      org_id: orgId,
      details: JSON.stringify({ total: records.length, updated: updatedCount }),
    });

    logger.info({ orgId, total: records.length, updated: updatedCount }, 'Bulk directory opt-out processed');

    res.json({
      total: records.length,
      updated: updatedCount,
      failed: records.length - updatedCount,
      results,
    });
  } catch (err) {
    logger.error({ err }, 'Bulk directory opt-out error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/v1/directory-opt-out ──────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const orgId = req.headers['x-org-id'] as string;
    if (!orgId) {
      res.status(400).json({ error: 'x-org-id header required' });
      return;
    }

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const offset = (page - 1) * limit;

    const { data, error, count } = await dbAny
      .from('anchors')
      .select('public_id, credential_type, directory_info_opt_out, created_at', { count: 'exact' })
      .eq('org_id', orgId)
      .in('credential_type', ['DEGREE', 'TRANSCRIPT', 'CERTIFICATE', 'CLE'])
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      logger.error({ error }, 'Failed to list directory opt-out status');
      res.status(500).json({ error: 'Failed to list records' });
      return;
    }

    res.json({
      records: data ?? [],
      total: count ?? 0,
      page,
      limit,
    });
  } catch (err) {
    logger.error({ err }, 'Directory opt-out list error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
