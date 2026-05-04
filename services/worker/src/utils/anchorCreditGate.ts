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
 */

import type { Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { deductOrgCredit } from './orgCredits.js';
import { logger } from './logger.js';

/**
 * Deduct one anchor credit for `orgId` and emit an appropriate response on
 * failure. Returns `true` if the caller may proceed, `false` if the response
 * has already been written (and the caller must early-return).
 */
export async function ensureAnchorCreditAvailable(
  // The Supabase client is passed in (rather than imported) so this helper
  // stays trivially mockable in tests without forcing a vi.mock of utils/db.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any, any, any>,
  orgId: string,
  res: Response,
): Promise<boolean> {
  const deduction = await deductOrgCredit(db, orgId, 1, 'anchor.create');
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
