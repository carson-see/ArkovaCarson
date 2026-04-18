/**
 * Org Compliance Audit API — "Audit My Organization" (NCA-03)
 *
 *   POST /api/v1/compliance/audit            — trigger audit, returns audit row
 *   GET  /api/v1/compliance/audit/:id        — fetch audit by id
 *   GET  /api/v1/compliance/audit            — list recent audits for org
 *
 * Behaviour:
 *   - Authenticated (org membership resolved via getCallerOrgId)
 *   - Idempotency: if a COMPLETED audit exists within the last 5 minutes
 *     for the same (org_id, jurisdiction_filter), return that row instead
 *     of running a new one.
 *   - Rate limited to 10 audits/hour/org at the service-role layer (the
 *     v1 router already wraps this route in aiRateLimiter for IP).
 *   - Synchronous compute: audits are fast (≤30s for 10k credentials) so
 *     we don't bother with a background queue; status stays 'COMPLETED'
 *     on success or 'FAILED' with error_code/error_message on exception.
 *   - Quarantine: v28 HIPAA and v29 FERPA surfacing is attached to the
 *     response via the org-audit engine (NVI-15).
 *
 * Jira: SCRUM-758 (NCA-03)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getCallerOrgId } from '../../compliance/auth-helpers.js';
import {
  calculateOrgAudit,
  type JurisdictionPair,
  type OrgAuditResult,
} from '../../compliance/org-audit.js';
import type { JurisdictionRule, OrgAnchor } from '../../compliance/score-calculator.js';

const router = Router();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

const TriggerAuditSchema = z.object({
  /** Optional filter: only audit these jurisdiction_code values. */
  jurisdictions: z.array(z.string().min(2).max(50)).max(50).optional(),
});

const AuditIdParam = z.object({
  id: z.string().uuid({ message: 'audit id must be a uuid' }),
});

const IDEMPOTENCY_WINDOW_MS = 5 * 60_000;

/**
 * Intelligence models we surface quarantine caveats for. Kept in-sync with
 * docs/runbooks/nvi-quarantine-2026-04-17.md.
 */
const ACTIVE_REGULATIONS = [
  { regulation: 'FCRA', version: 'v27.3' },
  { regulation: 'HIPAA', version: 'v28.0' },
  { regulation: 'FERPA', version: 'v29.0' },
];

// ───────────────────────────────────────────────────────────────────────────
// POST /api/v1/compliance/audit
// ───────────────────────────────────────────────────────────────────────────

router.post('/', async (req: Request, res: Response) => {
  const parsed = TriggerAuditSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const { jurisdictions: jurisdictionFilter } = parsed.data;

  const orgId = await getCallerOrgId(req, res);
  if (!orgId) return;

  // ─── Idempotency: return a recent completed audit if one exists ───
  try {
    const windowCutoff = new Date(Date.now() - IDEMPOTENCY_WINDOW_MS).toISOString();
    const { data: recent } = await dbAny
      .from('compliance_audits')
      .select('*')
      .eq('org_id', orgId)
      .eq('status', 'COMPLETED')
      .gte('completed_at', windowCutoff)
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle?.() ?? await dbAny
      .from('compliance_audits')
      .select('*')
      .eq('org_id', orgId)
      .eq('status', 'COMPLETED')
      .gte('completed_at', windowCutoff)
      .order('completed_at', { ascending: false })
      .limit(1)
      .single();

    if (recent?.id) {
      const sameFilter = arraysEqual(
        (recent.jurisdiction_filter ?? []) as string[],
        jurisdictionFilter ?? [],
      );
      if (sameFilter) {
        res.json({ ...shapeAuditRow(recent), idempotent: true });
        return;
      }
    }
  } catch {
    /* idempotency check failure is non-fatal — proceed with fresh audit */
  }

  const startedAt = new Date();
  try {
    const [jurisdictionPairs, rules, anchors] = await Promise.all([
      loadOrgJurisdictions(orgId, jurisdictionFilter),
      loadJurisdictionRules(orgId, jurisdictionFilter),
      loadOrgAnchors(orgId),
    ]);

    const result: OrgAuditResult = calculateOrgAudit({
      orgId,
      jurisdictions: jurisdictionPairs,
      rules,
      anchors,
      activeRegulations: ACTIVE_REGULATIONS,
    });

    const completedAt = new Date();
    const durationMs = completedAt.getTime() - startedAt.getTime();

    const { data: inserted, error: insertErr } = await dbAny
      .from('compliance_audits')
      .insert({
        org_id: orgId,
        triggered_by: req.authUserId ?? null,
        overall_score: result.overall_score,
        overall_grade: result.overall_grade,
        per_jurisdiction: result.per_jurisdiction,
        gaps: result.gaps,
        quarantines: result.quarantines,
        status: 'COMPLETED',
        started_at: startedAt.toISOString(),
        completed_at: completedAt.toISOString(),
        duration_ms: durationMs,
        jurisdiction_filter: jurisdictionFilter ?? null,
        metadata: {
          anchor_count: anchors.length,
          rule_count: rules.length,
          jurisdiction_pair_count: jurisdictionPairs.length,
          // NCA-05: recommendations live in metadata per migration 0217 comment.
          recommendations: result.recommendations,
        },
      })
      .select('*')
      .single();

    if (insertErr || !inserted) {
      logger.error({ err: insertErr, orgId }, 'failed to persist compliance audit');
      res.status(500).json({ error: 'Failed to persist audit result' });
      return;
    }

    res.status(201).json(shapeAuditRow(inserted));
  } catch (err) {
    const completedAt = new Date();
    logger.error({ err, orgId }, 'compliance audit computation failed');
    const durationMs = completedAt.getTime() - startedAt.getTime();
    // Best-effort record of the failure.
    await dbAny
      .from('compliance_audits')
      .insert({
        org_id: orgId,
        triggered_by: req.authUserId ?? null,
        overall_score: 0,
        overall_grade: 'F',
        status: 'FAILED',
        started_at: startedAt.toISOString(),
        completed_at: completedAt.toISOString(),
        duration_ms: durationMs,
        error_code: 'AUDIT_COMPUTE_ERROR',
        error_message: (err as Error).message?.slice(0, 500) ?? 'unknown',
        jurisdiction_filter: jurisdictionFilter ?? null,
      })
      .then(() => null, () => null);
    res.status(500).json({ error: 'Audit computation failed' });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// GET /api/v1/compliance/audit/:id
// ───────────────────────────────────────────────────────────────────────────

router.get('/:id', async (req: Request, res: Response) => {
  const paramParsed = AuditIdParam.safeParse(req.params);
  if (!paramParsed.success) {
    res.status(400).json({ error: paramParsed.error.issues[0].message });
    return;
  }
  const orgId = await getCallerOrgId(req, res);
  if (!orgId) return;

  const { data, error } = await dbAny
    .from('compliance_audits')
    .select('*')
    .eq('id', paramParsed.data.id)
    .eq('org_id', orgId)
    .single();

  if (error || !data) {
    res.status(404).json({ error: 'Audit not found' });
    return;
  }
  res.json(shapeAuditRow(data));
});

// ───────────────────────────────────────────────────────────────────────────
// GET /api/v1/compliance/audit   — list most-recent audits for the org
// ───────────────────────────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const orgId = await getCallerOrgId(req, res);
  if (!orgId) return;

  const limitRaw = Number.parseInt((req.query.limit as string | undefined) ?? '20', 10);
  const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 20));

  const { data, error } = await dbAny
    .from('compliance_audits')
    .select('*')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    res.status(500).json({ error: 'Failed to list audits' });
    return;
  }
  res.json({
    audits: (data ?? []).map(shapeAuditRow),
    count: data?.length ?? 0,
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

async function loadOrgJurisdictions(
  orgId: string,
  filter?: string[],
): Promise<JurisdictionPair[]> {
  // Orgs express jurisdiction interest via the organizations.jurisdictions
  // JSONB array. Fall back to scanning compliance_scores if none set so
  // previously-scored pairs are still audited.
  const { data: org } = await dbAny
    .from('organizations')
    .select('jurisdictions, industry')
    .eq('id', orgId)
    .maybeSingle();

  const configured = Array.isArray(org?.jurisdictions) ? (org!.jurisdictions as string[]) : [];
  const industry = (org?.industry as string | null) ?? 'accounting';

  let pairs: JurisdictionPair[] = configured.map((j) => ({
    jurisdiction_code: j,
    industry_code: industry,
  }));

  if (pairs.length === 0) {
    // Fallback: use distinct (jurisdiction, industry) pairs from prior scores.
    const { data: scores } = await dbAny
      .from('compliance_scores')
      .select('jurisdiction_code, industry_code')
      .eq('org_id', orgId);
    const seen = new Set<string>();
    for (const s of scores ?? []) {
      const key = `${s.jurisdiction_code}::${s.industry_code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({
        jurisdiction_code: s.jurisdiction_code as string,
        industry_code: s.industry_code as string,
      });
    }
  }

  if (filter?.length) {
    const allowed = new Set(filter);
    pairs = pairs.filter((p) => allowed.has(p.jurisdiction_code));
  }
  return pairs;
}

async function loadJurisdictionRules(
  _orgId: string,
  filter?: string[],
): Promise<JurisdictionRule[]> {
  let query = dbAny.from('jurisdiction_rules').select('*').limit(2000);
  if (filter?.length) query = query.in('jurisdiction_code', filter);
  const { data } = await query;
  return (data ?? []) as JurisdictionRule[];
}

async function loadOrgAnchors(orgId: string): Promise<OrgAnchor[]> {
  // 3-query parallel JOIN: anchors + integrity_scores + review_queue_items.
  // Schema per codex review on PR #411: anchors table uses `expires_at` +
  // `label`, not `not_after` + `title`. integrity_scores + review_queue_items
  // live on separate tables; joined here via client-side Map lookup so we can
  // surface integrity score + fraud flags alongside the anchor record.
  const [{ data: anchorsRaw }, { data: integrityRows }, { data: reviewRows }] = await Promise.all([
    dbAny
      .from('anchors')
      .select('id, credential_type, status, expires_at, label')
      .eq('org_id', orgId)
      .eq('status', 'SECURED')
      .limit(10_000),
    dbAny
      .from('integrity_scores')
      .select('anchor_id, overall_score, flags')
      .eq('org_id', orgId)
      .limit(10_000),
    dbAny
      .from('review_queue_items')
      .select('anchor_id, flags')
      .eq('org_id', orgId)
      .limit(10_000),
  ]);

  const scoreMap = new Map<string, { overall_score: number; flags: unknown }>();
  for (const row of (integrityRows ?? []) as Array<Record<string, unknown>>) {
    scoreMap.set(row.anchor_id as string, {
      overall_score: row.overall_score as number,
      flags: row.flags,
    });
  }

  const fraudMap = new Map<string, string[]>();
  for (const row of (reviewRows ?? []) as Array<Record<string, unknown>>) {
    const anchorId = row.anchor_id as string;
    const flags = Array.isArray(row.flags) ? (row.flags as string[]) : [];
    if (flags.length > 0) {
      const existing = fraudMap.get(anchorId) ?? [];
      fraudMap.set(anchorId, [...existing, ...flags]);
    }
  }

  return (anchorsRaw ?? []).map((a: Record<string, unknown>) => {
    const anchorId = a.id as string;
    const integrity = scoreMap.get(anchorId);
    const fraudFlags = fraudMap.get(anchorId) ?? [];
    return {
      id: anchorId,
      credential_type: (a.credential_type as string) ?? 'OTHER',
      status: a.status as string,
      integrity_score: integrity?.overall_score ?? null,
      fraud_flags: fraudFlags,
      expiry_date: (a.expires_at as string) ?? null,
      title: (a.label as string) ?? null,
    };
  });
}

function shapeAuditRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    org_id: row.org_id,
    overall_score: row.overall_score,
    overall_grade: row.overall_grade,
    per_jurisdiction: row.per_jurisdiction,
    gaps: row.gaps,
    quarantines: row.quarantines,
    status: row.status,
    started_at: row.started_at,
    completed_at: row.completed_at,
    duration_ms: row.duration_ms,
    jurisdiction_filter: row.jurisdiction_filter,
    error_code: row.error_code,
    error_message: row.error_message,
    metadata: row.metadata,
    created_at: row.created_at,
  };
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

export { router as complianceAuditRouter };
