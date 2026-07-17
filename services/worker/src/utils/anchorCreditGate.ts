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
 * SCRUM-2970 (BUG-2026-07-17-012) — the gate now REQUIRES a `referenceId`.
 * It previously called `deductOrgCredit` with none, which made migration
 * 0326's idempotency ledger a no-op on the primary anchor path (the RPC
 * only consults/writes `org_credit_deductions` when `p_reference_id IS NOT
 * NULL`), so any retry/redelivery double-deducted. Callers follow the
 * insert-then-deduct pattern (see `credential-sources.ts`): insert the
 * PENDING anchor row first, pass the new row's id as `referenceId` — a
 * fresh uuid per anchoring event, so a soft-delete + re-anchor is a NEW
 * billable event, while an HTTP retry of the same logical request is
 * absorbed by the endpoint's dedup lookup before ever reaching this gate —
 * and on a `false` return hard-delete the never-paid row as compensation.
 * Do NOT derive the referenceId from request content (e.g. the
 * fingerprint): a permanent ledger row keyed on content, combined with the
 * soft-delete-aware dedup lookups (`.is('deleted_at', null)`), would make
 * every re-anchor after a soft-delete free — even at zero balance.
 */

import type { Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { deductOrgCredit } from './orgCredits.js';
import { logger } from './logger.js';

/**
 * Deduct one anchor credit for `orgId` and emit an appropriate response on
 * failure. Returns `true` if the caller may proceed, `false` if the response
 * has already been written (and the caller must early-return, compensating
 * for any just-inserted anchor row).
 *
 * `referenceId` is REQUIRED (SCRUM-2970): pass the just-inserted anchor
 * row's id so the 0326 idempotency ledger dedupes a re-run of the same
 * anchoring event instead of double-deducting.
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
