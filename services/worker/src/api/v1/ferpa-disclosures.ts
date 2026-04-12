/**
 * FERPA Disclosure Log API — REG-01 (SCRUM-561)
 *
 * POST /api/v1/ferpa/disclosures    — Log a new disclosure (service_role or API key with verify scope)
 * GET  /api/v1/ferpa/disclosures    — List disclosures (org-scoped, admin/compliance_officer only)
 * GET  /api/v1/ferpa/disclosures/export — Export as CSV for institutional compliance audits
 */

import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const router = Router();

import { FERPA_PARTY_TYPES, FERPA_EXCEPTION_CATEGORIES } from '../../constants/ferpa.js';

// ─── Validation Schemas ──────────────────────────────────────────────────────

const CreateDisclosureSchema = z.object({
  requesting_party_name: z.string().min(1).max(500),
  requesting_party_type: z.enum(FERPA_PARTY_TYPES).default('other'),
  requesting_party_org: z.string().max(500).optional(),
  legitimate_interest: z.string().min(1).max(2000),
  disclosure_exception: z.enum(FERPA_EXCEPTION_CATEGORIES).default('other'),
  education_record_ids: z.array(z.string()).min(1),
  student_opt_out_checked: z.boolean().default(false),
  student_consent_obtained: z.boolean().default(false),
  notes: z.string().max(2000).optional(),
});

const ListDisclosuresSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  party_type: z.enum(FERPA_PARTY_TYPES).optional(),
  exception: z.enum(FERPA_EXCEPTION_CATEGORIES).optional(),
  from_date: z.string().optional(),
  to_date: z.string().optional(),
});

export type FerpaDisclosure = z.infer<typeof CreateDisclosureSchema>;

// ─── POST /api/v1/ferpa/disclosures ──────────────────────────────────────────

router.post('/disclosures', async (req, res) => {
  try {
    const orgId = req.headers['x-org-id'] as string;
    if (!orgId) {
      res.status(400).json({ error: 'x-org-id header required' });
      return;
    }

    const parsed = CreateDisclosureSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }

    const disclosure = parsed.data;

    const { data, error } = await db
      .from('ferpa_disclosure_log')
      .insert({
        org_id: orgId,
        requesting_party_name: disclosure.requesting_party_name,
        requesting_party_type: disclosure.requesting_party_type,
        requesting_party_org: disclosure.requesting_party_org ?? null,
        legitimate_interest: disclosure.legitimate_interest,
        disclosure_exception: disclosure.disclosure_exception,
        education_record_ids: disclosure.education_record_ids,
        student_opt_out_checked: disclosure.student_opt_out_checked,
        student_consent_obtained: disclosure.student_consent_obtained,
        api_key_id: (req as Record<string, unknown>).apiKeyId as string | undefined ?? null,
        notes: disclosure.notes ?? null,
      })
      .select('id, disclosed_at')
      .single();

    if (error) {
      logger.error({ error }, 'Failed to log FERPA disclosure');
      res.status(500).json({ error: 'Failed to log disclosure' });
      return;
    }

    logger.info({ disclosureId: data.id, orgId, partyType: disclosure.requesting_party_type }, 'FERPA disclosure logged');

    res.status(201).json({
      id: data.id,
      disclosed_at: data.disclosed_at,
      message: 'Disclosure logged per FERPA Section 99.32',
    });
  } catch (err) {
    logger.error({ err }, 'FERPA disclosure log error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/v1/ferpa/disclosures ───────────────────────────────────────────

router.get('/disclosures', async (req, res) => {
  try {
    const orgId = req.headers['x-org-id'] as string;
    if (!orgId) {
      res.status(400).json({ error: 'x-org-id header required' });
      return;
    }

    const parsed = ListDisclosuresSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
      return;
    }

    const { page, limit, party_type, exception, from_date, to_date } = parsed.data;
    const offset = (page - 1) * limit;

    let query = db
      .from('ferpa_disclosure_log')
      .select('*', { count: 'exact' })
      .eq('org_id', orgId)
      .order('disclosed_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (party_type) query = query.eq('requesting_party_type', party_type);
    if (exception) query = query.eq('disclosure_exception', exception);
    if (from_date) query = query.gte('disclosed_at', from_date);
    if (to_date) query = query.lte('disclosed_at', to_date);

    const { data, error, count } = await query;

    if (error) {
      logger.error({ error }, 'Failed to list FERPA disclosures');
      res.status(500).json({ error: 'Failed to list disclosures' });
      return;
    }

    res.json({
      disclosures: data ?? [],
      total: count ?? 0,
      page,
      limit,
    });
  } catch (err) {
    logger.error({ err }, 'FERPA disclosure list error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/v1/ferpa/disclosures/export ────────────────────────────────────

router.get('/disclosures/export', async (req, res) => {
  try {
    const orgId = req.headers['x-org-id'] as string;
    if (!orgId) {
      res.status(400).json({ error: 'x-org-id header required' });
      return;
    }

    const from_date = req.query.from_date as string | undefined;
    const to_date = req.query.to_date as string | undefined;

    const MAX_EXPORT_ROWS = 10000;

    let query = db
      .from('ferpa_disclosure_log')
      .select('*')
      .eq('org_id', orgId)
      .order('disclosed_at', { ascending: false })
      .limit(MAX_EXPORT_ROWS);

    if (from_date) query = query.gte('disclosed_at', from_date);
    if (to_date) query = query.lte('disclosed_at', to_date);

    const { data, error } = await query;

    if (error) {
      logger.error({ error }, 'Failed to export FERPA disclosures');
      res.status(500).json({ error: 'Failed to export disclosures' });
      return;
    }

    const records = data ?? [];

    // Build CSV
    const headers = [
      'Disclosure Date',
      'Requesting Party',
      'Party Type',
      'Party Organization',
      'Legitimate Interest',
      'Exception Category',
      'Education Record IDs',
      'Student Opt-Out Checked',
      'Student Consent Obtained',
      'Notes',
    ];

    const rows = records.map((r) => [
      r.disclosed_at,
      r.requesting_party_name,
      r.requesting_party_type,
      r.requesting_party_org ?? '',
      r.legitimate_interest,
      r.disclosure_exception,
      (r.education_record_ids as string[]).join('; '),
      r.student_opt_out_checked ? 'Yes' : 'No',
      r.student_consent_obtained ? 'Yes' : 'No',
      r.notes ?? '',
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map((row) =>
        row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','),
      ),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="ferpa-disclosures-${orgId}.csv"`);
    res.send(csvContent);
  } catch (err) {
    logger.error({ err }, 'FERPA disclosure export error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
