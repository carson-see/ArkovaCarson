/**
 * SCRUM-1631 (PR #680) — shared anchor-credit gate helper.
 *
 * Extracted from `services/worker/src/api/v1/anchor-submit.ts` so the
 * pre-signing contract anchor handler (and any future anchor endpoints)
 * can reuse the exact same 402 / 503 / 402 response shapes. SonarCloud
 * Quality Gate flagged the inline duplicate at PR-time; pulling it here
 * gives both endpoints a single source of truth for credit-failure UX.
 *
 * SCRUM-1170-B set the original credit-deduction contract; this is a
 * mechanical extraction that does not change any response shape or
 * status-code mapping.
 *
 * SCRUM-2970 (BUG-2026-07-17-012) — the gate now REQUIRES a stable
 * `referenceId`. It previously called `deductOrgCredit` with none, which
 * made migration 0326's idempotency ledger a no-op on the primary anchor
 * path (the RPC only consults/writes `org_credit_deductions` when
 * `p_reference_id IS NOT NULL`), so any retry/redelivery double-deducted.
 */

import { createHash } from 'crypto';
import type { Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { deductOrgCredit } from './orgCredits.js';
import { logger } from './logger.js';

/**
 * Derive a deterministic, uuid-shaped reference id for a credit deduction
 * from the request's stable identity.
 *
 * Both current callers run BEFORE any anchor row exists, and the per-attempt
 * `public_id` is regenerated on every retry — so the only identity that is
 * stable across a retry of the SAME logical request is the (endpoint scope,
 * org, fingerprint) triple, which matches each endpoint's own idempotency
 * semantics (anchor-submit dedups globally on fingerprint; pre-signing
 * dedups on org + fingerprint + credential_type). `scope` keeps the two
 * endpoints' deductions distinct for the same fingerprint.
 *
 * The output is formatted as an RFC 9562 version-8 (custom, name-derived)
 * uuid because `org_credit_deductions.reference_id` is `uuid NOT NULL`
 * (migration 0326).
 */
export function deriveAnchorCreditReferenceId(
  scope: 'anchor_submit' | 'contract_presigning',
  orgId: string,
  fingerprint: string,
): string {
  const digest = createHash('sha256')
    .update(`arkova:anchor-credit-ref:${scope}:${orgId}:${fingerprint}`)
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  // Set version (8 = custom/name-derived per RFC 9562) and RFC variant bits
  // so the value is a well-formed uuid, not just 32 random-looking hex chars.
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Deduct one anchor credit for `orgId` and emit an appropriate response on
 * failure. Returns `true` if the caller may proceed, `false` if the response
 * has already been written (and the caller must early-return).
 *
 * `referenceId` is REQUIRED (SCRUM-2970): it must be a uuid that is stable
 * across a retry of the same logical request and unique across distinct
 * requests, so the 0326 idempotency ledger dedupes retries instead of
 * double-deducting. Callers without a persisted stable id should derive one
 * via {@link deriveAnchorCreditReferenceId}.
 */
export async function ensureAnchorCreditAvailable(
  // The Supabase client is passed in (rather than imported) so this helper
  // stays trivially mockable in tests without forcing a vi.mock of utils/db.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any, any, any>,
  orgId: string,
  res: Response,
  referenceId: string,
): Promise<boolean> {
  const deduction = await deductOrgCredit(db, orgId, 1, 'anchor.create', referenceId);
  if (deduction.allowed) return true;

  if (deduction.error === 'insufficient_credits') {
    res.status(402).json({
      error: 'insufficient_credits',
      message: 'Organization has insufficient anchor credits for this cycle.',
      balance: deduction.balance,
      required: deduction.required,
    });
    return false;
  }

  if (deduction.error === 'rpc_failure') {
    logger.error({ err: deduction.message, orgId }, 'org_credit_deduct_rpc_failure');
    res.status(503).json({ error: 'credit_check_unavailable' });
    return false;
  }

  logger.warn({ orgId }, 'org_credit_deduct_blocked_uninitialized');
  res.status(402).json({
    error: 'org_credits_not_initialized',
    message:
      'This organization is not provisioned for credit-based billing. ' +
      'An operator must seed org_credits before this API key can submit.',
  });
  return false;
}
