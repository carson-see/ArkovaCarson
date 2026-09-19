/**
 * SCRUM-1740 — anchor quota gate for partner-sandbox orgs.
 *
 * An org with `org_credits.cap_enforced = true` AND `anchor_quota IS NOT NULL`
 * has a hard cap on the number of anchors it may submit. Migration 0297 added
 * the quota column; 0440 (SCRUM-4474) added `cap_enforced`.
 *
 * `cap_enforced` — NOT `is_test` — is the switch. Before 0440 this gate keyed
 * on `is_test`, which also means "never bill this org through Stripe"
 * (meteredBilling.ts). That made a billable customer with a contractual cap
 * unrepresentable: HakiChain, invoiced and capped at 2,000 documents, had to be
 * flagged a TEST org on 2026-09-02 purely to get its cap enforced — silently
 * excluding it from metered billing. The two concepts are now separate.
 *
 * Behavior matrix:
 *   - org has `anchor_quota = NULL`                              → `{allowed: true}` (no cap)
 *   - org has `cap_enforced = false`                             → `{allowed: true}` (cap recorded but inert)
 *   - org has `anchor_quota = N` and current count < N           → `{allowed: true}` (under cap)
 *   - org has `anchor_quota = N` and current count >= N          → `{allowed: false}` → 402 `quota_exhausted`
 *
 * `is_test` is deliberately NOT consulted here any more. An org may be billable
 * and capped, a sandbox and uncapped, or any other combination.
 *
 * "Current count" is non-deleted anchors (`deleted_at IS NULL`) for the
 * org. Re-submissions of an existing fingerprint already short-circuit at
 * the dedup-check above this gate, so they do not consume quota.
 *
 * The gate runs AFTER the duplicate-fingerprint dedup so re-anchoring an
 * existing fingerprint does not consume quota — matching the partner
 * guide's sandbox-economy promise.
 *
 * A config or usage read failure fails closed with a retryable 503. Otherwise
 * an enforced contractual cap can be bypassed whenever its backing read is
 * unavailable. A successful missing row and an explicit `cap_enforced=false`
 * remain allowed states.
 */

import type { Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from './logger.js';

interface OrgQuotaRow {
  anchor_quota: number | null;
  /** SCRUM-4474 — the sole switch for whether anchor_quota bites. */
  cap_enforced: boolean | null;
}

function writeQuotaCheckUnavailable(res: Response): false {
  res.status(503)
    .type('application/problem+json')
    .json({
      type: 'https://arkova.ai/errors/quota-check-unavailable',
      title: 'Anchor quota check unavailable',
      status: 503,
      error: 'quota_check_unavailable',
      message: 'Anchor capacity could not be verified. Retry the request.',
    });
  return false;
}

/**
 * Returns true if the caller may proceed; false if a 402 or 503 response has
 * been written (and the caller must early-return). An org without an enforced
 * cap is a no-op `true` after one cheap row read.
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
    .select('anchor_quota, cap_enforced')
    .eq('org_id', orgId)
    .maybeSingle<OrgQuotaRow>();

  if (error) {
    logger.error({ err: error.message ?? String(error), orgId }, 'anchor_quota_gate_read_failed');
    return writeQuotaCheckUnavailable(res);
  }

  // No row, cap not enforced, or no cap configured → no gating.
  //
  // Both halves are required. A row carrying `anchor_quota` with
  // `cap_enforced = false` is a RECORDED but INERT cap — that is a real state
  // in prod (Login Defense holds anchor_quota = 15 that has never applied), and
  // treating a stored number as permission to start refusing requests would cap
  // a live partner nobody decided to cap.
  if (!row || row.cap_enforced !== true || row.anchor_quota == null) return true;

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
    return writeQuotaCheckUnavailable(res);
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
