/**
 * Admin Actions API — Arkova Internal Only
 *
 * POST /api/admin/users/:id/promote-admin           — Toggle platform admin flag
 * POST /api/admin/users/:id/change-role             — Change user role (INDIVIDUAL/ORG_ADMIN)
 * POST /api/admin/users/:id/set-org                 — Assign user to an organization
 * POST /api/admin/organizations/:id/quota           — Set an org's free-tier testing cap (SCRUM-2225)
 * POST /api/admin/organizations/:id/credits/adjust  — Add/remove org credits (L2-A5)
 *
 * All endpoints gated behind platform admin check.
 * Uses service_role to bypass protective triggers.
 */

/** Loose UUID-shape check — the RPC also validates via its `uuid` column type, but a
 *  client-side format check turns a malformed key into a clean 400 instead of a
 *  Postgres cast-error surfaced as a 500. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

import type { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { db } from '../utils/db.js';
import { isPlatformAdmin } from '../utils/platformAdmin.js';

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
    // Must disable triggers to update protected fields
    // Use raw SQL via RPC since Supabase client can't disable triggers
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
 * Body: { anchor_quota: number | null, is_test?: boolean }
 *
 * SCRUM-2225 — platform-admin sets an org's free-tier testing cap. The cap is
 * enforced on the anchor-submit hot path by ensureAnchorQuotaAvailable():
 * when is_test=true AND anchor_quota IS NOT NULL, the org gets a 402
 * `quota_exhausted` once its non-deleted anchor count reaches the quota.
 *
 *   anchor_quota: non-negative integer = the cap; null = uncapped.
 *   is_test:      defaults true (a capped free-tier org). Set false to convert
 *                 an org to an uncapped/billable account.
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

  const { anchor_quota, is_test = true } = req.body ?? {};

  if (
    anchor_quota !== null &&
    (typeof anchor_quota !== 'number' || !Number.isInteger(anchor_quota) || anchor_quota < 0)
  ) {
    res.status(400).json({ error: 'anchor_quota must be a non-negative integer, or null for uncapped' });
    return;
  }
  if (typeof is_test !== 'boolean') {
    res.status(400).json({ error: 'is_test must be a boolean' });
    return;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any).rpc('admin_set_org_anchor_quota', {
      p_org_id: orgId,
      p_anchor_quota: anchor_quota,
      p_is_test: is_test,
      p_actor: userId,
    });

    if (error) {
      logger.error({ error, orgId }, 'Failed to set org anchor quota');
      res.status(500).json({ error: 'Failed to set organization quota' });
      return;
    }

    logger.info({ orgId, anchor_quota, is_test, setBy: userId }, 'Org anchor quota updated');
    res.json({ success: true, org_id: orgId, anchor_quota, is_test, credits: data ?? null });
  } catch (error) {
    logger.error({ error, orgId }, 'Set org quota request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
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

  const { amount, reason, idempotency_key: idempotencyKey } = req.body ?? {};

  if (
    typeof amount !== 'number' ||
    !Number.isInteger(amount) ||
    amount === 0 ||
    Math.abs(amount) > 2_147_483_647
  ) {
    res.status(400).json({ error: 'amount must be a non-zero integer (positive to add, negative to remove)' });
    return;
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    res.status(400).json({ error: 'reason is required' });
    return;
  }
  if (reason.length > 500) {
    res.status(400).json({ error: 'reason must be 500 characters or fewer' });
    return;
  }
  if (typeof idempotencyKey !== 'string' || !UUID_RE.test(idempotencyKey)) {
    res.status(400).json({ error: 'idempotency_key must be a UUID string' });
    return;
  }

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

    if (!row || row.success !== true) {
      const rpcError = row?.error ?? 'unknown_error';
      const status = rpcError === 'insufficient_balance' ? 409
        : rpcError === 'idempotency_key_conflict' ? 409
        : rpcError === 'org_not_initialized' ? 404
        : 400;
      res.status(status).json({
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
