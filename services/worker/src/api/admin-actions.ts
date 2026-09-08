/**
 * Admin Actions API — Arkova Internal Only
 *
 * POST /api/admin/users/:id/promote-admin           — Toggle platform admin flag
 * POST /api/admin/users/:id/change-role             — Change user role (INDIVIDUAL/ORG_ADMIN)
 * POST /api/admin/users/:id/set-org                 — Assign user to an organization
 * POST /api/admin/organizations                    — Create an organization (SCRUM-3873)
 * POST /api/admin/users                             — Create an account (SCRUM-3873)
 * POST /api/admin/organizations/:id/quota           — Set an org's free-tier testing cap (SCRUM-2225)
 * POST /api/admin/organizations/:id/credits/adjust  — Add/remove org credits (L2-A5)
 *
 * All endpoints gated behind platform admin check.
 *
 * The profile RPCs (change-role / promote-admin / set-org) run as service_role.
 * The protective BEFORE UPDATE triggers on `profiles` recognise service_role and
 * step aside, so these are plain UPDATEs -- EXCEPT role immutability, which
 * service_role alone does NOT satisfy: `check_role_immutability` additionally
 * requires the transaction-local flag `arkova.allow_role_change` that
 * `admin_change_user_role` sets around its own UPDATE. A direct service_role
 * UPDATE of `profiles.role` from here would still be rejected, by design --
 * see the backfills in invitations.ts / admin-org-members.ts, which rely on
 * exactly that. They used to wrap the write in
 * `ALTER TABLE profiles DISABLE/ENABLE TRIGGER`, which took ShareRowExclusiveLock
 * on a table in the auth hot path and barriered every subsequent profile write
 * behind it; migration 0428 removed that DDL.
 */

/** Loose UUID-shape check — the RPC also validates via its `uuid` column type, but a
 *  client-side format check turns a malformed key into a clean 400 instead of a
 *  Postgres cast-error surfaced as a 500. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

import type { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { db } from '../utils/db.js';
import { isPlatformAdmin } from '../utils/platformAdmin.js';
import {
  createOrganization,
  createUserAccount,
  validateCreateOrganizationInput,
  validateCreateUserAccountInput,
  ProvisioningError,
  PROVISIONING_ERROR_STATUS,
} from './admin-provisioning.js';

/**
 * POST /api/admin/users/:id/promote-admin
 * Body: { is_platform_admin: boolean }
 */
export async function handlePromoteAdmin(
  userId: string,
  targetUserId: string,
  req: Request,
  res: Response,
): Promise<void> {
  const isAdmin = await isPlatformAdmin(userId);
  if (!isAdmin) {
    res.status(403).json({ error: 'Forbidden — platform admin access required' });
    return;
  }

  const { is_platform_admin } = req.body;
  if (typeof is_platform_admin !== 'boolean') {
    res.status(400).json({ error: 'is_platform_admin must be a boolean' });
    return;
  }

  // Prevent self-demotion
  if (userId === targetUserId && !is_platform_admin) {
    res.status(400).json({ error: 'Cannot remove your own platform admin status' });
    return;
  }

  try {
    // RPC rather than a direct table write: `is_platform_admin` is protected by
    // trg_protect_platform_admin, which reverts the change for any caller that is
    // not service_role. Since 0428 the RPC also re-reads the row and raises if the
    // flag did not take, so a reverted write surfaces here as an error rather than
    // a false success.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db as any).rpc('admin_set_platform_admin', {
      p_user_id: targetUserId,
      p_is_admin: is_platform_admin,
    });

    if (error) {
      logger.error({ error, targetUserId }, 'Failed to update platform admin status');
      res.status(500).json({ error: 'Failed to update admin status' });
      return;
    }

    logger.info({ targetUserId, is_platform_admin, promotedBy: userId }, 'Platform admin status updated');
    res.json({ success: true, is_platform_admin });
  } catch (error) {
    logger.error({ error, targetUserId }, 'Promote admin request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/admin/users/:id/change-role
 * Body: { role: 'INDIVIDUAL' | 'ORG_ADMIN' }
 */
export async function handleChangeRole(
  userId: string,
  targetUserId: string,
  req: Request,
  res: Response,
): Promise<void> {
  const isAdmin = await isPlatformAdmin(userId);
  if (!isAdmin) {
    res.status(403).json({ error: 'Forbidden — platform admin access required' });
    return;
  }

  const { role } = req.body;
  if (!['INDIVIDUAL', 'ORG_ADMIN', 'ORG_MEMBER'].includes(role)) {
    res.status(400).json({ error: 'role must be INDIVIDUAL, ORG_ADMIN, or ORG_MEMBER' });
    return;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db as any).rpc('admin_change_user_role', {
      p_user_id: targetUserId,
      p_new_role: role,
    });

    if (error) {
      logger.error({ error, targetUserId, role }, 'Failed to change user role');
      res.status(500).json({ error: 'Failed to change role' });
      return;
    }

    logger.info({ targetUserId, role, changedBy: userId }, 'User role changed');
    res.json({ success: true, role });
  } catch (error) {
    logger.error({ error, targetUserId }, 'Change role request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/admin/users/:id/set-org
 * Body: { org_id: string | null, org_role?: 'owner' | 'admin' | 'member' }
 */
export async function handleSetOrg(
  userId: string,
  targetUserId: string,
  req: Request,
  res: Response,
): Promise<void> {
  const isAdmin = await isPlatformAdmin(userId);
  if (!isAdmin) {
    res.status(403).json({ error: 'Forbidden — platform admin access required' });
    return;
  }

  const { org_id, org_role = 'member' } = req.body;

  if (org_id !== null && typeof org_id !== 'string') {
    res.status(400).json({ error: 'org_id must be a UUID string or null' });
    return;
  }

  if (!['owner', 'admin', 'member'].includes(org_role)) {
    res.status(400).json({ error: 'org_role must be owner, admin, or member' });
    return;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db as any).rpc('admin_set_user_org', {
      p_user_id: targetUserId,
      p_org_id: org_id,
      p_org_role: org_role,
    });

    if (error) {
      logger.error({ error, targetUserId, org_id }, 'Failed to set user org');
      res.status(500).json({ error: 'Failed to set organization' });
      return;
    }

    logger.info({ targetUserId, org_id, org_role, setBy: userId }, 'User organization updated');
    res.json({ success: true, org_id, org_role });
  } catch (error) {
    logger.error({ error, targetUserId }, 'Set org request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/admin/organizations/:id/quota
 * Body: { anchor_quota: number | null, cap_enforced?: boolean, is_test?: boolean }
 *
 * SCRUM-2225, reworked by SCRUM-4474 — platform-admin sets an org's document
 * cap. Enforced on the anchor-submit hot path by ensureAnchorQuotaAvailable():
 * when cap_enforced=true AND anchor_quota IS NOT NULL, the org gets a 402
 * `quota_exhausted` once its non-deleted anchor count reaches the quota.
 *
 *   anchor_quota: non-negative integer = the cap; null = uncapped.
 *   cap_enforced: does that number actually bite? Defaults to "a number was
 *                 supplied", so an admin who sets a cap gets a working cap.
 *   is_test:      billing ONLY — true means never fire a Stripe meter event for
 *                 this org (meteredBilling.ts). It no longer affects the cap.
 *
 * The three are independent. Before SCRUM-4474 the cap was welded to is_test,
 * so capping a billable customer silently removed it from metered billing —
 * which is what happened to HakiChain on 2026-09-02.
 *
 * `is_test` defaults to the org's CURRENT value rather than to `true`: this
 * endpoint is "set the cap", and a caller who says nothing about billing must
 * not have a billing flag changed underneath them.
 */
export async function handleSetOrgQuota(
  userId: string,
  orgId: string,
  req: Request,
  res: Response,
): Promise<void> {
  const isAdmin = await isPlatformAdmin(userId);
  if (!isAdmin) {
    res.status(403).json({ error: 'Forbidden — platform admin access required' });
    return;
  }

  const body = req.body ?? {};
  const { anchor_quota } = body;

  if (
    anchor_quota !== null &&
    (typeof anchor_quota !== 'number' || !Number.isInteger(anchor_quota) || anchor_quota < 0)
  ) {
    res.status(400).json({ error: 'anchor_quota must be a non-negative integer, or null for uncapped' });
    return;
  }
  if (body.is_test !== undefined && typeof body.is_test !== 'boolean') {
    res.status(400).json({ error: 'is_test must be a boolean' });
    return;
  }
  if (body.cap_enforced !== undefined && typeof body.cap_enforced !== 'boolean') {
    res.status(400).json({ error: 'cap_enforced must be a boolean' });
    return;
  }

  // Default: setting a number means you want it to bite; clearing it means you
  // do not. An explicit cap_enforced always wins.
  const capEnforced: boolean = body.cap_enforced ?? anchor_quota !== null;

  if (capEnforced && anchor_quota === null) {
    res.status(400).json({ error: 'cap_enforced requires a non-null anchor_quota' });
    return;
  }

  try {
    // is_test is a BILLING flag and is not this endpoint's subject. Omitting it
    // must leave it untouched, so read the current value rather than defaulting
    // to true — the old default silently converted billable orgs into
    // Stripe-excluded test orgs.
    let isTest: boolean;
    if (typeof body.is_test === 'boolean') {
      isTest = body.is_test;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: current, error: readError } = await (db as any)
        .from('org_credits')
        .select('is_test')
        .eq('org_id', orgId)
        .maybeSingle();
      if (readError) {
        logger.error({ error: readError, orgId }, 'Failed to read current is_test for quota update');
        res.status(503).json({ error: 'Could not read current billing flag; quota unchanged' });
        return;
      }
      isTest = current?.is_test === true;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any).rpc('admin_set_org_cap', {
      p_org_id: orgId,
      p_anchor_quota: anchor_quota,
      p_cap_enforced: capEnforced,
      p_is_test: isTest,
      p_actor: userId,
    });

    if (error) {
      logger.error({ error, orgId }, 'Failed to set org anchor quota');
      res.status(500).json({ error: 'Failed to set organization quota' });
      return;
    }

    logger.info({ orgId, anchor_quota, cap_enforced: capEnforced, is_test: isTest, setBy: userId }, 'Org anchor quota updated');
    res.json({ success: true, org_id: orgId, anchor_quota, cap_enforced: capEnforced, is_test: isTest, credits: data ?? null });
  } catch (error) {
    logger.error({ error, orgId }, 'Set org quota request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
}

interface AdjustOrgCreditInput {
  amount: number;
  reason: string;
  idempotencyKey: string;
}

/**
 * Validates the request body for `handleAdjustOrgCredit`. Extracted so the
 * handler's own cognitive complexity stays under the linted threshold
 * (SonarCloud typescript:S3776) — this is pure input validation with no
 * side effects, so it's safe to unit test and reuse in isolation.
 */
function validateAdjustOrgCreditBody(
  body: unknown,
): { ok: true; value: AdjustOrgCreditInput } | { ok: false; error: string } {
  const { amount, reason, idempotency_key: idempotencyKey } = (body ?? {}) as {
    amount?: unknown;
    reason?: unknown;
    idempotency_key?: unknown;
  };

  if (
    typeof amount !== 'number' ||
    !Number.isInteger(amount) ||
    amount === 0 ||
    Math.abs(amount) > 2_147_483_647
  ) {
    return { ok: false, error: 'amount must be a non-zero integer (positive to add, negative to remove)' };
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    return { ok: false, error: 'reason is required' };
  }
  if (reason.length > 500) {
    return { ok: false, error: 'reason must be 500 characters or fewer' };
  }
  if (typeof idempotencyKey !== 'string' || !UUID_RE.test(idempotencyKey)) {
    return { ok: false, error: 'idempotency_key must be a UUID string' };
  }

  return { ok: true, value: { amount, reason, idempotencyKey } };
}

/**
 * Maps an `admin_adjust_org_credit` RPC error code to an HTTP status.
 * Extracted from a nested ternary chain (SonarCloud typescript:S3358) into
 * an explicit, independently testable lookup.
 */
function rpcErrorToHttpStatus(rpcError: string): number {
  const STATUS_BY_RPC_ERROR: Record<string, number> = {
    insufficient_balance: 409,
    idempotency_key_conflict: 409,
    org_not_initialized: 404,
  };
  return STATUS_BY_RPC_ERROR[rpcError] ?? 400;
}

/**
 * POST /api/admin/organizations/:id/credits/adjust
 * Body: { amount: number, reason: string, idempotency_key: string }
 *
 * L2-A5 (founder demand, ratified 2-sprint plan R7): platform-admin
 * add/remove on org_credits.balance. `amount` is signed — positive grants
 * credits, negative revokes them. `reason` is mandatory (audit trail).
 * `idempotency_key` is mandatory — a retry with the same
 * (org_id, idempotency_key, reason) is a no-op (idempotent: true), not a
 * double-adjustment.
 *
 * Dispatches to `admin_adjust_org_credit` (migration 0375), which reuses the
 * existing 0326/0341 `org_credit_deductions` idempotency ledger
 * (entry_type GRANT/REVOKE) and writes an `ORG_CREDIT_ADJUSTED` audit_events
 * row, all inside one transaction. Never lets balance go below zero.
 */
export async function handleAdjustOrgCredit(
  userId: string,
  orgId: string,
  req: Request,
  res: Response,
): Promise<void> {
  const isAdmin = await isPlatformAdmin(userId);
  if (!isAdmin) {
    res.status(403).json({ error: 'Forbidden — platform admin access required' });
    return;
  }

  const validation = validateAdjustOrgCreditBody(req.body);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }
  const { amount, reason, idempotencyKey } = validation.value;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any).rpc('admin_adjust_org_credit', {
      p_org_id: orgId,
      p_amount: amount,
      p_reason: reason,
      p_idempotency_key: idempotencyKey,
      p_actor: userId,
    });

    if (error) {
      logger.error({ error, orgId }, 'Failed to adjust org credit');
      res.status(500).json({ error: 'Failed to adjust organization credits' });
      return;
    }

    const row = data as {
      success?: boolean;
      error?: string;
      balance?: number;
      requested?: number;
      adjusted?: number;
      entry_type?: string;
      idempotent?: boolean;
    } | null;

    if (row?.success !== true) {
      const rpcError = row?.error ?? 'unknown_error';
      res.status(rpcErrorToHttpStatus(rpcError)).json({
        error: rpcError,
        balance: row?.balance,
        requested: row?.requested,
      });
      return;
    }

    logger.info(
      { orgId, amount, entry_type: row.entry_type, idempotent: row.idempotent === true, adjustedBy: userId },
      'Org credit balance adjusted',
    );
    res.json({
      success: true,
      org_id: orgId,
      balance: row.balance,
      adjusted: row.adjusted,
      entry_type: row.entry_type,
      idempotent: row.idempotent === true,
    });
  } catch (error) {
    logger.error({ error, orgId }, 'Adjust org credit request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── SCRUM-3873: provisioning (create org / create account) ───────────────
// Business logic lives in admin-provisioning.ts (dependency-injected, unit
// tested). These handlers own only the platform-admin gate, body validation,
// and the error-code -> HTTP mapping.
//
// Gating is both per-handler (here) and structural: routes/admin.ts mounts a
// platform-admin middleware on '/admin', so a future handler that forgets the
// check is still not reachable unauthenticated.
//
// Organization provisioning uses0439's atomic, service-only RPC. Account
// creation uses the Auth admin API with a protected explicit-placement marker.

/**
 * POST /api/admin/organizations
 * Body: { display_name, legal_name?, anchor_quota?, credits?, is_test?, allow_duplicate_name? }
 */
export async function handleCreateOrganization(
  userId: string,
  req: Request,
  res: Response,
): Promise<void> {
  if (!(await isPlatformAdmin(userId))) {
    res.status(403).json({ error: 'Forbidden — platform admin access required' });
    return;
  }

  const parsed = validateCreateOrganizationInput(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    const organization = await createOrganization({ db, logger }, userId, parsed.value);
    res.status(201).json({ success: true, organization });
  } catch (error) {
    if (error instanceof ProvisioningError) {
      res.status(PROVISIONING_ERROR_STATUS[error.code]).json({
        error: error.message,
        code: error.code,
        ...(error.existingOrgId ? { existing_org_id: error.existingOrgId } : {}),
      });
      return;
    }
    logger.error({ error }, 'Create organization request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/admin/users
 * Body: { email, full_name?, role, org_id?, org_role?, send_invite_email? }
 *
 * `is_platform_admin` is deliberately NOT accepted here — promotion stays on
 * the dedicated promote-admin endpoint with its own self-demotion guard.
 */
export async function handleCreateUserAccount(
  userId: string,
  req: Request,
  res: Response,
): Promise<void> {
  if (!(await isPlatformAdmin(userId))) {
    res.status(403).json({ error: 'Forbidden — platform admin access required' });
    return;
  }

  const parsed = validateCreateUserAccountInput(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    const account = await createUserAccount({ db, logger }, userId, parsed.value);
    res.status(201).json({ success: true, account });
  } catch (error) {
    if (error instanceof ProvisioningError) {
      res.status(PROVISIONING_ERROR_STATUS[error.code]).json({ error: error.message, code: error.code });
      return;
    }
    logger.error({ error }, 'Create user account request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
}
