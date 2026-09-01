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
 * SCRUM-3866 — enforcement scope is now per-org, not only global.
 *
 * The previous note here said the tenant-scoped flip belonged at the route
 * layer, "the route reads the per-tenant Confluence allowlist before calling
 * this". No route ever did, and a Confluence page is not an authorization
 * source. Meanwhile the global flag was the ONLY lever, which made enabling
 * enforcement for one partner an all-tenants change: 7 of 13 production orgs
 * sat at a zero balance, including the Login Defense partner org and the UAT
 * demo org, so flipping it to give one partner a real budget would have
 * started 402-ing all of them (pre-mortem F2).
 *
 * Enforcement now applies when the global flag is on OR the org's own
 * `credit_enforcement_enabled` column (migration 0429) is true. That column is
 * writable only by service_role or a platform admin — an org cannot switch off
 * the gate that bills it.
 */

import { config } from '../config.js';
import { logger } from './logger.js';
import type { db } from './db.js';

export interface DeductionResult {
  allowed: boolean;
  /** Present on `allowed=false` to drive the API response shape. */
  error?: 'insufficient_credits' | 'org_not_initialized' | 'rpc_failure';
  /** Remaining balance after the deduction, or current balance on failure. */
  balance?: number;
  /** True when the RPC reused a prior deduction for the same reference id. */
  idempotent?: boolean;
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
  idempotent?: boolean;
  required?: number;
  error?: string;
}

type DbLike = typeof db;

/**
 * Is anchor-credit enforcement in force for this org?
 *
 * True when the global flag is on (which short-circuits before any query, so
 * the enforced-everywhere case costs no extra round trip) or when the org is
 * individually enrolled via `organizations.credit_enforcement_enabled`.
 *
 * FAILS OPEN. A read error or a missing row returns `false` — not enforced —
 * which preserves the behaviour pinned by `orgCreditEnforcementFlag.test.ts`:
 * "a missing / false flag NEVER hard-blocks the anchor path for non-credit
 * orgs". Failing closed here would convert a transient read error into a 503
 * for every org on the platform in order to protect a budget that applies to
 * one partner. The residual risk is that an enrolled org gets an unbilled
 * anchor during a database incident; it is logged at error level so those can
 * be reconciled, and the enrolled path still fails closed on the deduction RPC
 * itself (503 `credit_check_unavailable`).
 */
async function isEnforcedForOrg(database: DbLike, orgId: string): Promise<boolean> {
  if (config.enableOrgCreditEnforcement) return true;

  const { data, error } = await (database
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .from as any)('organizations')
    .select('credit_enforcement_enabled')
    .eq('id', orgId)
    .maybeSingle();

  if (error) {
    logger.error({ orgId, err: error.message }, 'org_credit_enforcement_lookup_failed');
    return false;
  }

  return data?.credit_enforcement_enabled === true;
}

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
  if (!(await isEnforcedForOrg(database, orgId))) {
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
    return {
      allowed: true,
      balance: row.balance,
      ...(row.idempotent === true ? { idempotent: true } : {}),
    };
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
