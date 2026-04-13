/**
 * FERPA Directory Information Opt-Out API — REG-02 (SCRUM-562)
 *
 * PATCH /api/v1/directory-opt-out/:publicId   — Toggle opt-out for a single anchor
 * POST  /api/v1/directory-opt-out/bulk        — Bulk import opt-out status
 * GET   /api/v1/directory-opt-out             — List opt-out status for org's education anchors
 */

import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { FERPA_EDUCATION_TYPES } from '../../constants/ferpa.js';
import { requireOrgId } from '../../middleware/requireOrgId.js';

const router = Router();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

export const ToggleOptOutSchema = z.object({
  opt_out: z.boolean(),
});

export const BulkOptOutSchema = z.object({
  records: z.array(z.object({
    public_id: z.string().min(1),
    opt_out: z.boolean(),
  })).min(1).max(1000),
});

router.use(requireOrgId);

// ─── PATCH /:publicId ───────────────────────────────────────────────────────

router.patch('/:publicId', async (req, res) => {
  try {
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
      .eq('org_id', req.orgId)
      .select('public_id, directory_info_opt_out')
      .single();

    if (error || !data) {
      res.status(404).json({ error: 'Record not found or not in your organization' });
      return;
    }

    void dbAny.from('audit_events').insert({
      event_type: 'DIRECTORY_OPT_OUT_CHANGED',
      event_category: 'COMPLIANCE',
      target_type: 'anchor',
      target_id: publicId,
      org_id: req.orgId,
      details: JSON.stringify({ opt_out, public_id: publicId }),
    });

    logger.info({ publicId, orgId: req.orgId, optOut: opt_out }, 'Directory info opt-out updated');

    res.json({
      public_id: data.public_id,
      directory_info_opt_out: data.directory_info_opt_out,
    });
  } catch (err) {
    logger.error({ err }, 'Directory opt-out toggle error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /bulk — batch update (single query, not N+1) ─────────────────────

router.post('/bulk', async (req, res) => {
  try {
    const parsed = BulkOptOutSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }

    const { records } = parsed.data;

    // Split into opt-in and opt-out groups for two batch updates instead of N serial updates
    const optOutIds = records.filter(r => r.opt_out).map(r => r.public_id);
    const optInIds = records.filter(r => !r.opt_out).map(r => r.public_id);

    const batchResults = await Promise.all([
      optOutIds.length > 0
        ? dbAny.from('anchors').update({ directory_info_opt_out: true })
            .in('public_id', optOutIds).eq('org_id', req.orgId).select('public_id')
        : { data: [], error: null },
      optInIds.length > 0
        ? dbAny.from('anchors').update({ directory_info_opt_out: false })
            .in('public_id', optInIds).eq('org_id', req.orgId).select('public_id')
        : { data: [], error: null },
    ]);

    const updatedIds = new Set([
      ...(batchResults[0].data ?? []).map((r: { public_id: string }) => r.public_id),
      ...(batchResults[1].data ?? []).map((r: { public_id: string }) => r.public_id),
    ]);

    const results = records.map(r => ({
      public_id: r.public_id,
      updated: updatedIds.has(r.public_id),
      ...(updatedIds.has(r.public_id) ? {} : { error: 'Not found' }),
    }));

    const updatedCount = updatedIds.size;

    void dbAny.from('audit_events').insert({
      event_type: 'DIRECTORY_OPT_OUT_BULK_UPDATE',
      event_category: 'COMPLIANCE',
      target_type: 'organization',
      target_id: req.orgId,
      org_id: req.orgId,
      details: JSON.stringify({ total: records.length, updated: updatedCount }),
    });

    logger.info({ orgId: req.orgId, total: records.length, updated: updatedCount }, 'Bulk directory opt-out processed');

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

// ─── GET / ──────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const offset = (page - 1) * limit;

    const { data, error, count } = await dbAny
      .from('anchors')
      .select('public_id, credential_type, directory_info_opt_out, created_at', { count: 'exact' })
      .eq('org_id', req.orgId)
      .in('credential_type', [...FERPA_EDUCATION_TYPES])
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      logger.error({ error }, 'Failed to list directory opt-out status');
      res.status(500).json({ error: 'Failed to list records' });
      return;
    }

    res.json({ records: data ?? [], total: count ?? 0, page, limit });
  } catch (err) {
    logger.error({ err }, 'Directory opt-out list error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
