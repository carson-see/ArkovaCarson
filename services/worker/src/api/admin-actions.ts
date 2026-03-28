/**
 * Admin Actions API — Arkova Internal Only
 *
 * POST /api/admin/users/:id/promote-admin   — Toggle platform admin flag
 * POST /api/admin/users/:id/change-role     — Change user role (INDIVIDUAL/ORG_ADMIN)
 * POST /api/admin/users/:id/set-org         — Assign user to an organization
 *
 * All endpoints gated behind platform admin check.
 * Uses service_role to bypass protective triggers.
 */

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
    const { error } = await db.rpc('admin_set_platform_admin', {
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
    const { error } = await db.rpc('admin_change_user_role', {
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
    const { error } = await db.rpc('admin_set_user_org', {
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
