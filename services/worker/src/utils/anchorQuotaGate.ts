/**
 * SCRUM-1740 — anchor quota gate for partner-sandbox orgs.
 *
 * Sandbox orgs (`org_credits.is_test = true` AND `anchor_quota IS NOT NULL`)
 * have a hard cap on the number of anchors they may submit during the beta
 * window. The migration 0297 added the column; this helper enforces it.
 *
 * Behavior matrix:
 *   - org has `anchor_quota = NULL` (every prod org)            → `{allowed: true}` (no cap)
 *   - org has `is_test = false`                                  → `{allowed: true}` (only test orgs are gated)
 *   - org has `anchor_quota = N` and current count < N           → `{allowed: true}` (under cap)
 *   - org has `anchor_quota = N` and current count >= N          → `{allowed: false}` → 402 `quota_exhausted`
 *
 * "Current count" is non-deleted anchors (`deleted_at IS NULL`) for the
 * org. Re-submissions of an existing fingerprint already short-circuit at
 * the dedup-check above this gate, so they do not consume quota.
 *
 * The gate runs AFTER the duplicate-fingerprint dedup so re-anchoring an
 * existing fingerprint does not consume quota — matching the partner
 * guide's sandbox-economy promise.
 *
 * Gated for safety: if the count query fails for any reason, we fail OPEN
 * (allow the request) and log loudly. The cap is a soft business rule on a
 * sandbox org — failing closed on a transient DB blip would block partners
 * from doing valid work.
 */

import type { Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from './logger.js';

interface OrgQuotaRow {
  is_test: boolean | null;
  anchor_quota: number | null;
}

/**
 * Returns true if the caller may proceed; false if a 402 response has been
 * written (and the caller must early-return). For non-sandbox orgs this is
 * always a no-op `true` after one cheap row read.
 */
export async function ensureAnchorQuotaAvailable(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any, any, any>,
  orgId: string,
  res: Response,
): Promise<boolean> {
  // Read the quota config for this org.
  const { data: row, error } = await db
    .from('org_credits')
    .select('is_test, anchor_quota')
    .eq('org_id', orgId)
    .maybeSingle<OrgQuotaRow>();

  if (error) {
    // Fail open on read failure — see file header.
    logger.error({ err: error.message ?? String(error), orgId }, 'anchor_quota_gate_read_failed');
    return true;
  }

  // No row, or non-sandbox org, or no cap configured → no gating.
  if (!row || row.is_test !== true || row.anchor_quota == null) return true;

  // We only need to know if usage is >= quota — an exact total is unnecessary.
  // SELECT id LIMIT (quota+1) on the (org_id, deleted_at) index returns at
  // most quota+1 rows; if rows.length > quota the cap is hit. This avoids
  // the full COUNT(*) scan that fails the SCRUM-1254 (R0-8) repo-wide
  // baseline check — that scan style on the 2.9M-row anchors table caused
  // the 60-second PostgREST timeouts in prod (BUG-2026-04-22-001).
  const quota = row.anchor_quota;
  const { data: rows, error: countError } = await db
    .from('anchors')
    .select('id')
    .eq('org_id', orgId)
    .is('deleted_at', null)
    .limit(quota + 1);

  if (countError) {
    logger.error({ err: countError.message ?? String(countError), orgId }, 'anchor_quota_gate_count_failed');
    return true;
  }

  const used = rows?.length ?? 0;

  if (used < quota) return true;

  // At or over cap. Return RFC 7807-style problem+json so partners can
  // dispatch on `error === 'quota_exhausted'`. Schema is documented in the
  // partner brief and the SCRUM-1739 spec.
  logger.warn({ orgId, used, quota }, 'anchor_quota_exhausted');
  res.status(402)
    .type('application/problem+json')
    .json({
      type: 'https://arkova.ai/errors/quota-exhausted',
      title: 'Anchor quota exhausted',
      status: 402,
      error: 'quota_exhausted',
      message: `This sandbox org has used all ${quota} of its allotted anchors. Contact Arkova for a top-up.`,
      used,
      quota,
    });
  return false;
}
