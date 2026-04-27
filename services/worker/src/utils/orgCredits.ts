/**
 * SCRUM-1170-B — worker-side helper for org-credit deduction.
 *
 * Wraps the `deduct_org_credit` RPC from migration 0278 with the structured
 * `insufficient_credits` response shape that `/api/v1/anchor` returns to the
 * caller per the SCRUM-1170 design doc.
 *
 * Gated by `config.enableOrgCreditEnforcement`. When the flag is OFF the
 * helper short-circuits to `{ allowed: true, reason: 'feature_disabled' }`
 * so existing callers without org-credit setup are unaffected.
 *
 * Gated by `config.enableOrgCreditEnforcement`. Tenant-scoped flip is
 * intentionally NOT here — the design wants the carve-out to happen at the
 * route layer (the route reads the per-tenant Confluence allowlist before
 * calling this) so this helper has a single, simple contract.
 */

import { config } from '../config.js';
import type { db } from './db.js';

export interface DeductionResult {
  allowed: boolean;
  /** Present on `allowed=false` to drive the API response shape. */
  error?: 'insufficient_credits' | 'org_not_initialized' | 'rpc_failure';
  /** Remaining balance after the deduction, or current balance on failure. */
  balance?: number;
  /** Amount that was requested. Echoed back for the API response body. */
  required?: number;
  /** When `error === 'rpc_failure'`, the underlying message (sanitized). */
  message?: string;
  /** Soft signal — the helper short-circuited because the flag is off. */
  reason?: 'feature_disabled';
}

interface DeductOrgCreditRpcRow {
  success: boolean;
  balance?: number;
  deducted?: number;
  required?: number;
  error?: string;
}

type DbLike = typeof db;

/**
 * Deduct `amount` credits from `orgId`. The org must be initialized in
 * `org_credits` (lazy-init happens via allocation, not here).
 *
 * Behavior matrix:
 *   - flag off              → `{ allowed: true, reason: 'feature_disabled' }`
 *   - RPC `success: true`   → `{ allowed: true, balance }`
 *   - RPC `error: 'insufficient_credits'`  → `{ allowed: false, error: 'insufficient_credits', balance, required }`
 *   - RPC `error: 'org_not_initialized'`   → `{ allowed: false, error: 'org_not_initialized' }`
 *   - PostgREST/network error → `{ allowed: false, error: 'rpc_failure', message }`
 */
export async function deductOrgCredit(
  database: DbLike,
  orgId: string,
  amount: number,
  reason: string,
  referenceId?: string,
): Promise<DeductionResult> {
  if (!config.enableOrgCreditEnforcement) {
    return { allowed: true, reason: 'feature_disabled' };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (database.rpc as any)('deduct_org_credit', {
    p_org_id: orgId,
    p_amount: amount,
    p_reason: reason,
    p_reference_id: referenceId ?? null,
  });

  if (error) {
    return {
      allowed: false,
      error: 'rpc_failure',
      message: error.message,
    };
  }

  const row = data as DeductOrgCreditRpcRow | null;
  if (!row) {
    return { allowed: false, error: 'rpc_failure', message: 'empty response' };
  }
  if (row.success === true) {
    return { allowed: true, balance: row.balance };
  }
  if (row.error === 'insufficient_credits') {
    return {
      allowed: false,
      error: 'insufficient_credits',
      balance: row.balance,
      required: row.required ?? amount,
    };
  }
  if (row.error === 'org_not_initialized') {
    return { allowed: false, error: 'org_not_initialized' };
  }
  return { allowed: false, error: 'rpc_failure', message: row.error ?? 'unknown' };
}
