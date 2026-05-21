/**
 * CLE Verification Endpoint (Phase 1.5 — Legal Education)
 *
 * GET /api/v1/cle/verify?bar_number={number}&jurisdiction={state}
 * GET /api/v1/cle/credits?bar_number={number}&jurisdiction={state}
 * POST /api/v1/cle/submit — Submit CLE completion for anchoring
 *
 * Enables:
 * - CLE providers to anchor course completions
 * - Attorneys to view aggregated CLE credits
 * - State bars to verify compliance via API
 *
 * Pricing: $0.005 per verification query (x402)
 */

import { createHash } from 'node:crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { verifyAuthToken } from '../../auth.js';
import { config } from '../../config.js';

const router = Router();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

// ─── Schemas ────────────────────────────────────────────────────────────────

const CleVerifySchema = z.object({
  bar_number: z.string().min(1).max(100),
  jurisdiction: z.string().min(1).max(100).optional(),
});

const CleCreditsSchema = z.object({
  bar_number: z.string().min(1).max(100),
  jurisdiction: z.string().min(1).max(100).optional(),
  period_start: z.string().optional(),
  period_end: z.string().optional(),
});

const CleSubmitSchema = z.object({
  bar_number: z.string().min(1).max(100),
  attorney_name: z.string().min(1).max(200).optional(),
  course_title: z.string().min(1).max(500),
  provider_name: z.string().min(1).max(500),
  provider_accreditation_number: z.string().max(100).optional(),
  credit_hours: z.number().positive().max(100),
  credit_category: z.enum([
    'General',
    'Ethics',
    'Professional Responsibility',
    'Substance Abuse',
    'Diversity',
    'Technology',
    'Mental Health',
    'Elimination of Bias',
  ]),
  delivery_method: z.enum([
    'Live In-Person',
    'Live Webcast',
    'On-Demand',
    'Self-Study',
    'Hybrid',
  ]).optional(),
  jurisdiction: z.string().min(1).max(100),
  completion_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  course_number: z.string().max(100).optional(),
});

type CleSubmitInput = z.infer<typeof CleSubmitSchema>;

function cleMetadata(row: Record<string, unknown>): Record<string, unknown> {
  return row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown>
    : {};
}

function publicString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function publicNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toPublicCleRecord(row: Record<string, unknown>): Record<string, unknown> {
  const meta = cleMetadata(row);
  const record: Record<string, unknown> = {
    public_id: publicString(row.public_id),
    course_title: publicString(meta.course_title),
    provider_name: publicString(meta.provider_name),
    credit_hours: publicNumber(meta.credit_hours),
    credit_category: publicString(meta.credit_category) ?? 'General',
    delivery_method: publicString(meta.delivery_method),
    completion_date: publicString(meta.completion_date),
    anchor_status: publicString(row.status),
    anchored_at: publicString(row.created_at),
  };
  const jurisdiction = publicString(meta.jurisdiction);
  if (jurisdiction) {
    record.jurisdiction = jurisdiction;
  }
  return record;
}

function toPublicCleAttestation(row: Record<string, unknown>): Record<string, unknown> {
  return {
    public_id: publicString(row.public_id),
    attestation_type: publicString(row.attestation_type),
    status: publicString(row.status),
    created_at: publicString(row.created_at),
  };
}

function safeFilenameSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 48) || 'CLE';
}

function buildCleSubmissionFingerprint(data: CleSubmitInput): string {
  return createHash('sha256')
    .update(JSON.stringify({
      bar_number: data.bar_number,
      course_title: data.course_title,
      provider_name: data.provider_name,
      jurisdiction: data.jurisdiction,
      completion_date: data.completion_date,
      course_number: data.course_number ?? null,
    }))
    .digest('hex');
}

// ─── CLE Compliance Requirements by State (subset of major states) ──────────

const CLE_REQUIREMENTS: Record<string, {
  total_hours: number;
  ethics_hours: number;
  period_years: number;
  notes: string;
}> = {
  'California': { total_hours: 25, ethics_hours: 4, period_years: 3, notes: 'Includes 1 hr competence issues, 1 hr elimination of bias' },
  'New York': { total_hours: 24, ethics_hours: 4, period_years: 2, notes: 'Includes 1 hr diversity, 1 hr cybersecurity' },
  'Texas': { total_hours: 15, ethics_hours: 3, period_years: 1, notes: 'Includes 1 hr substance abuse/mental health' },
  'Florida': { total_hours: 33, ethics_hours: 5, period_years: 3, notes: 'Includes 3 hrs technology, 5 hrs ethics' },
  'Illinois': { total_hours: 30, ethics_hours: 6, period_years: 2, notes: 'Includes 1 hr mental health/substance abuse, 1 hr diversity' },
  'Pennsylvania': { total_hours: 12, ethics_hours: 2, period_years: 1, notes: 'Includes 1 hr ethics, 1 hr substance abuse' },
  'Ohio': { total_hours: 24, ethics_hours: 2.5, period_years: 2, notes: 'Includes 0.5 hr substance abuse' },
  'Georgia': { total_hours: 12, ethics_hours: 1, period_years: 1, notes: 'Includes 1 hr ethics, 1 hr professionalism' },
  'Michigan': { total_hours: 12, ethics_hours: 2, period_years: 1, notes: 'Newly admitted: 15 hrs in first year' },
  'Virginia': { total_hours: 12, ethics_hours: 2, period_years: 1, notes: 'Includes 2 hrs ethics' },
  'Massachusetts': { total_hours: 12, ethics_hours: 2, period_years: 1, notes: 'Voluntary but tracked' },
  'New Jersey': { total_hours: 24, ethics_hours: 4, period_years: 2, notes: 'Includes 2 hrs diversity/inclusion' },
  'Washington': { total_hours: 45, ethics_hours: 6, period_years: 3, notes: 'Includes 1 hr equity/inclusion' },
  'Colorado': { total_hours: 45, ethics_hours: 7, period_years: 3, notes: 'Includes 2 hrs equity/diversity/inclusivity' },
  'Arizona': { total_hours: 15, ethics_hours: 3, period_years: 1, notes: 'Includes 1 hr substance abuse/mental health' },
};

// ─── GET /cle/verify — Verify CLE compliance for an attorney ────────────────

router.get('/verify', async (req: Request, res: Response) => {
  const parsed = CleVerifySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { bar_number, jurisdiction } = parsed.data;
  const sanitizedBarNumber = bar_number.replace(/[%_]/g, '');

  try {
    // Find all CLE anchors for this bar number
    const { data: anchors } = await db
      .from('anchors')
      .select('public_id, credential_type, metadata, status, created_at')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .eq('credential_type', 'CLE' as any)
      .eq('status', 'SECURED')
      .order('created_at', { ascending: false });

    // Filter by bar_number in metadata
    const requestedJurisdiction = jurisdiction?.toLowerCase();
    const cleRecords = (anchors ?? []).filter((a: Record<string, unknown>) => {
      const meta = a.metadata as Record<string, unknown> | null;
      if (meta?.bar_number !== sanitizedBarNumber) {
        return false;
      }
      if (!requestedJurisdiction) {
        return true;
      }
      const recordJurisdiction = typeof meta?.jurisdiction === 'string'
        ? meta.jurisdiction.toLowerCase()
        : '';
      return recordJurisdiction.includes(requestedJurisdiction);
    });

    // Also check attestations
    // eslint-disable-next-line arkova/missing-org-filter -- public verification endpoint
    const { data: attestations } = await dbAny
      .from('attestations')
      .select('public_id, attestation_type, status, created_at')
      .eq('status', 'ACTIVE')
      .ilike('subject_identifier', `%${sanitizedBarNumber}%`)
      .limit(50);

    const cleAttestations = (attestations ?? []).filter((a: Record<string, unknown>) => {
      const type = (a.attestation_type as string ?? '').toLowerCase();
      return type.includes('cle') || type.includes('legal education') || type.includes('continuing education');
    });

    // Calculate credit totals
    let totalHours = 0;
    let ethicsHours = 0;
    const creditsByCategory: Record<string, number> = {};

    for (const record of cleRecords) {
      const meta = record.metadata as Record<string, unknown> | null;
      const hours = Number(meta?.credit_hours ?? 0);
      const category = String(meta?.credit_category ?? 'General');

      totalHours += hours;
      creditsByCategory[category] = (creditsByCategory[category] ?? 0) + hours;

      if (['Ethics', 'Professional Responsibility'].includes(category)) {
        ethicsHours += hours;
      }
    }

    // Check compliance against jurisdiction requirements
    let complianceStatus: 'compliant' | 'deficient' | 'unknown' = 'unknown';
    let requirements = null;

    if (jurisdiction && CLE_REQUIREMENTS[jurisdiction]) {
      requirements = CLE_REQUIREMENTS[jurisdiction];
      const annualizedHours = totalHours; // Simplified — real impl would check period
      complianceStatus = (
        annualizedHours >= requirements.total_hours &&
        ethicsHours >= requirements.ethics_hours
      ) ? 'compliant' : 'deficient';
    }

    const response: Record<string, unknown> = {
      compliance_status: complianceStatus,
      summary: {
        total_cle_hours: totalHours,
        ethics_hours: ethicsHours,
        credits_by_category: creditsByCategory,
        total_anchored_records: cleRecords.length,
        total_attestations: cleAttestations.length,
      },
      requirements,
      records: cleRecords.slice(0, 20).map(toPublicCleRecord),
      attestations: cleAttestations.slice(0, 10).map(toPublicCleAttestation),
      verified_at: new Date().toISOString(),
    };
    if (jurisdiction) {
      response.jurisdiction = jurisdiction;
    }
    res.json(response);
  } catch (err) {
    logger.error({ error: err }, 'cle-verify: unexpected error');
    res.status(500).json({ error: 'CLE verification failed' });
  }
});

// ─── GET /cle/credits — List CLE credits for an attorney ────────────────────

router.get('/credits', async (req: Request, res: Response) => {
  const parsed = CleCreditsSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { bar_number, jurisdiction, period_start, period_end } = parsed.data;
  const sanitizedBarNumber = bar_number.replace(/[%_]/g, '');

  try {
    let query = db
      .from('anchors')
      .select('public_id, credential_type, metadata, status, created_at')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .eq('credential_type', 'CLE' as any)
      .in('status', ['SECURED', 'SUBMITTED', 'PENDING'])
      .order('created_at', { ascending: false });

    if (period_start) {
      query = query.gte('created_at', period_start);
    }
    if (period_end) {
      query = query.lte('created_at', period_end);
    }

    const { data: anchors } = await query;

    // Filter by bar_number in metadata
    let credits = (anchors ?? []).filter((a: Record<string, unknown>) => {
      const meta = a.metadata as Record<string, unknown> | null;
      return meta?.bar_number === sanitizedBarNumber;
    });

    // Filter by jurisdiction if specified
    if (jurisdiction) {
      credits = credits.filter((a: Record<string, unknown>) => {
        const meta = a.metadata as Record<string, unknown> | null;
        const metadataJurisdiction = meta?.jurisdiction;
        const publicJurisdiction = typeof metadataJurisdiction === 'string'
          ? metadataJurisdiction
          : '';
        return publicJurisdiction.toLowerCase().includes(jurisdiction.toLowerCase());
      });
    }

    const response: Record<string, unknown> = {
      total_credits: credits.length,
      credits: credits.map(toPublicCleRecord),
    };
    if (jurisdiction) {
      response.jurisdiction = jurisdiction;
    }
    res.json(response);
  } catch (err) {
    logger.error({ error: err }, 'cle-credits: unexpected error');
    res.status(500).json({ error: 'CLE credit lookup failed' });
  }
});

// ─── POST /cle/submit — Submit CLE completion for anchoring ─────────────────

router.post('/submit', async (req: Request, res: Response) => {
  // Requires authentication (JWT or API key)
  const authHeader = req.headers.authorization;
  let userId: string | null = null;

  if (authHeader?.startsWith('Bearer ') && !authHeader.startsWith('Bearer ak_')) {
    const token = authHeader.slice(7);
    userId = await verifyAuthToken(token, config, logger);
  } else if (req.apiKey) {
    userId = req.apiKey.userId ?? null;
  }

  if (!userId) {
    res.status(401).json({ error: 'Authentication required to submit CLE credits' });
    return;
  }

  const parsed = CleSubmitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const data = parsed.data;

  try {
    const fingerprint = buildCleSubmissionFingerprint(data);
    // Create anchor with CLE metadata
    const { data: anchor, error: insertError } = await db
      .from('anchors')
      .insert({
        user_id: userId,
        fingerprint,
        filename: `CLE_${safeFilenameSegment(data.jurisdiction)}_${data.completion_date}_${fingerprint.slice(0, 12)}.json`,
        file_size: 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        credential_type: 'CLE' as any,
        metadata: {
          bar_number: data.bar_number,
          attorney_name: data.attorney_name ?? null,
          course_title: data.course_title,
          provider_name: data.provider_name,
          provider_accreditation_number: data.provider_accreditation_number ?? null,
          credit_hours: data.credit_hours,
          credit_category: data.credit_category,
          delivery_method: data.delivery_method ?? null,
          jurisdiction: data.jurisdiction,
          completion_date: data.completion_date,
          course_number: data.course_number ?? null,
          submitted_via: 'api',
        },
      })
      .select('public_id')
      .single();

    if (insertError) {
      logger.error({ error: insertError }, 'cle-submit: insert failed');
      res.status(500).json({ error: 'Failed to submit CLE credit' });
      return;
    }

    logger.info({
      jurisdiction: data.jurisdiction,
      credit_hours: data.credit_hours,
      public_id: anchor.public_id,
    }, 'cle.credit.submitted');

    res.status(201).json({
      public_id: anchor.public_id,
      status: 'PENDING',
      message: 'CLE credit submitted for anchoring. Will be included in next batch.',
      credit: {
        course_title: data.course_title,
        credit_hours: data.credit_hours,
        credit_category: data.credit_category,
        jurisdiction: data.jurisdiction,
        completion_date: data.completion_date,
      },
    });
  } catch (err) {
    logger.error({ error: err }, 'cle-submit: unexpected error');
    res.status(500).json({ error: 'CLE submission failed' });
  }
});

// ─── GET /cle/requirements — Get CLE requirements by state ──────────────────

router.get('/requirements', (_req: Request, res: Response) => {
  const jurisdictions = Object.entries(CLE_REQUIREMENTS).map(([state, req]) => ({
    jurisdiction: state,
    ...req,
  }));

  res.json({
    total_jurisdictions: jurisdictions.length,
    jurisdictions,
    note: 'Requirements shown are for general practitioners. Newly admitted, specialist, and pro bono exemptions may apply. Verify with your state bar for exact requirements.',
  });
});

export { router as cleVerifyRouter };
