/**
 * Sub-Organization Management API (IDT-11)
 *
 * Endpoints for parent org admins to approve/revoke sub-org affiliations.
 * These require SECURITY DEFINER-style logic because the parent org admin
 * needs to update a DIFFERENT org's parent_approval_status.
 *
 *   POST /api/v1/org/sub-orgs/approve  — Approve a pending sub-org
 *   POST /api/v1/org/sub-orgs/revoke   — Revoke an approved sub-org
 *   GET  /api/v1/org/sub-orgs          — List sub-orgs for current user's org
 *   POST /api/v1/org/sub-orgs/request  — Request affiliation with a parent org
 *   POST /api/v1/org/sub-orgs/cancel   — Cancel pending affiliation request
 */

import { Router, Request, Response } from 'express';
import { logger } from '../../utils/logger.js';
import { db as _db } from '../../utils/db.js';

// Sub-org columns from migration 0128 are not yet in generated types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = _db as any;

export const orgSubOrgsRouter = Router();

/** Helper to get userId from request */
function getUserId(req: Request): string | undefined {
  return (req as unknown as { userId?: string }).userId;
}

/** Helper to get user's org_id and role */
async function getUserOrgInfo(userId: string): Promise<{ orgId: string | null; role: string | null }> {
  const { data } = await db
    .from('org_members')
    .select('org_id, role')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();
  return { orgId: data?.org_id ?? null, role: data?.role ?? null };
}

/** Check if user is admin/owner of their org */
function isOrgAdmin(role: string | null): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * GET /api/v1/org/sub-orgs
 *
 * List sub-orgs for the current user's organization (parent view).
 */
orgSubOrgsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { orgId } = await getUserOrgInfo(userId);
    if (!orgId) {
      res.status(400).json({ error: 'You must belong to an organization' });
      return;
    }

    const { data: subOrgs, error } = await db
      .from('organizations')
      .select('id, display_name, domain, verification_status, parent_approval_status, created_at, logo_url')
      .eq('parent_org_id', orgId)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error({ error }, 'Failed to fetch sub-orgs');
      res.status(500).json({ error: 'Failed to fetch affiliated organizations' });
      return;
    }

    // Get max_sub_orgs for the parent
    const { data: parentOrg } = await db
      .from('organizations')
      .select('max_sub_orgs')
      .eq('id', orgId)
      .single();

    res.json({
      subOrgs: subOrgs ?? [],
      maxSubOrgs: parentOrg?.max_sub_orgs ?? null,
      count: subOrgs?.length ?? 0,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to fetch sub-orgs');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/org/sub-orgs/approve
 *
 * Parent org admin approves a pending sub-org affiliation.
 * Body: { childOrgId: string }
 */
orgSubOrgsRouter.post('/approve', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { orgId, role } = await getUserOrgInfo(userId);
    if (!orgId) {
      res.status(400).json({ error: 'You must belong to an organization' });
      return;
    }

    if (!isOrgAdmin(role)) {
      res.status(403).json({ error: 'Admin permissions required' });
      return;
    }

    const { childOrgId } = req.body as { childOrgId?: string };
    if (!childOrgId) {
      res.status(400).json({ error: 'childOrgId is required' });
      return;
    }

    // Verify the child org exists and is pending approval for THIS parent
    const { data: childOrg, error: fetchError } = await db
      .from('organizations')
      .select('id, parent_org_id, parent_approval_status, display_name')
      .eq('id', childOrgId)
      .single();

    if (fetchError || !childOrg) {
      res.status(404).json({ error: 'Organization not found' });
      return;
    }

    if (childOrg.parent_org_id !== orgId) {
      res.status(403).json({ error: 'This organization is not affiliated with yours' });
      return;
    }

    if (childOrg.parent_approval_status === 'APPROVED') {
      res.status(400).json({ error: 'Organization is already approved' });
      return;
    }

    // Check max_sub_orgs limit
    const { data: parentOrg } = await db
      .from('organizations')
      .select('max_sub_orgs')
      .eq('id', orgId)
      .single();

    if (parentOrg?.max_sub_orgs) {
      const { count } = await db
        .from('organizations')
        .select('id', { count: 'exact', head: true })
        .eq('parent_org_id', orgId)
        .eq('parent_approval_status', 'APPROVED');

      if (count !== null && count >= parentOrg.max_sub_orgs) {
        res.status(400).json({
          error: `Maximum affiliate limit reached (${parentOrg.max_sub_orgs})`,
        });
        return;
      }
    }

    // Approve the sub-org (service_role via worker — bypasses RLS)
    const { error: updateError } = await db
      .from('organizations')
      .update({
        parent_approval_status: 'APPROVED',
        parent_approved_at: new Date().toISOString(),
      })
      .eq('id', childOrgId);

    if (updateError) {
      logger.error({ error: updateError }, 'Failed to approve sub-org');
      res.status(500).json({ error: 'Failed to approve organization' });
      return;
    }

    // Audit
    await db.from('audit_events').insert({
      actor_id: userId,
      event_type: 'SUB_ORG_APPROVED',
      event_category: 'ORG',
      target_type: 'organization',
      target_id: childOrgId,
      org_id: orgId,
      details: `Approved sub-org affiliation: ${childOrg.display_name}`,
    });

    logger.info({ orgId, childOrgId }, 'Sub-org approved');

    res.json({ status: 'APPROVED', childOrgId });
  } catch (error) {
    logger.error({ error }, 'Failed to approve sub-org');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/org/sub-orgs/revoke
 *
 * Parent org admin revokes an approved sub-org affiliation.
 * Body: { childOrgId: string }
 */
orgSubOrgsRouter.post('/revoke', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { orgId, role } = await getUserOrgInfo(userId);
    if (!orgId) {
      res.status(400).json({ error: 'You must belong to an organization' });
      return;
    }

    if (!isOrgAdmin(role)) {
      res.status(403).json({ error: 'Admin permissions required' });
      return;
    }

    const { childOrgId } = req.body as { childOrgId?: string };
    if (!childOrgId) {
      res.status(400).json({ error: 'childOrgId is required' });
      return;
    }

    // Verify the child org exists and belongs to this parent
    const { data: childOrg, error: fetchError } = await db
      .from('organizations')
      .select('id, parent_org_id, parent_approval_status, display_name')
      .eq('id', childOrgId)
      .single();

    if (fetchError || !childOrg) {
      res.status(404).json({ error: 'Organization not found' });
      return;
    }

    if (childOrg.parent_org_id !== orgId) {
      res.status(403).json({ error: 'This organization is not affiliated with yours' });
      return;
    }

    if (childOrg.parent_approval_status === 'REVOKED') {
      res.status(400).json({ error: 'Affiliation is already revoked' });
      return;
    }

    // Revoke the sub-org
    const { error: updateError } = await db
      .from('organizations')
      .update({
        parent_approval_status: 'REVOKED',
      })
      .eq('id', childOrgId);

    if (updateError) {
      logger.error({ error: updateError }, 'Failed to revoke sub-org');
      res.status(500).json({ error: 'Failed to revoke affiliation' });
      return;
    }

    // Audit
    await db.from('audit_events').insert({
      actor_id: userId,
      event_type: 'SUB_ORG_REVOKED',
      event_category: 'ORG',
      target_type: 'organization',
      target_id: childOrgId,
      org_id: orgId,
      details: `Revoked sub-org affiliation: ${childOrg.display_name}`,
    });

    logger.info({ orgId, childOrgId }, 'Sub-org revoked');

    res.json({ status: 'REVOKED', childOrgId });
  } catch (error) {
    logger.error({ error }, 'Failed to revoke sub-org');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/org/sub-orgs/request
 *
 * Child org requests affiliation with a parent org.
 * Body: { parentOrgId: string }
 */
orgSubOrgsRouter.post('/request', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { orgId, role } = await getUserOrgInfo(userId);
    if (!orgId) {
      res.status(400).json({ error: 'You must belong to an organization' });
      return;
    }

    if (!isOrgAdmin(role)) {
      res.status(403).json({ error: 'Admin permissions required' });
      return;
    }

    const { parentOrgId } = req.body as { parentOrgId?: string };
    if (!parentOrgId) {
      res.status(400).json({ error: 'parentOrgId is required' });
      return;
    }

    if (parentOrgId === orgId) {
      res.status(400).json({ error: 'Cannot affiliate with yourself' });
      return;
    }

    // Check current org isn't already affiliated
    const { data: currentOrg } = await db
      .from('organizations')
      .select('parent_org_id, parent_approval_status')
      .eq('id', orgId)
      .single();

    if (currentOrg?.parent_org_id && currentOrg.parent_approval_status !== 'REVOKED') {
      res.status(400).json({ error: 'Your organization already has an active or pending affiliation' });
      return;
    }

    // Check parent org exists and is verified
    const { data: parentOrg, error: parentError } = await db
      .from('organizations')
      .select('id, display_name, verification_status, parent_org_id')
      .eq('id', parentOrgId)
      .single();

    if (parentError || !parentOrg) {
      res.status(404).json({ error: 'Parent organization not found' });
      return;
    }

    if (parentOrg.verification_status !== 'VERIFIED') {
      res.status(400).json({ error: 'Can only affiliate with verified organizations' });
      return;
    }

    // Cannot affiliate with an org that is itself a sub-org
    if (parentOrg.parent_org_id) {
      res.status(400).json({ error: 'Cannot affiliate with a sub-organization' });
      return;
    }

    // Set affiliation request
    const { error: updateError } = await db
      .from('organizations')
      .update({
        parent_org_id: parentOrgId,
        parent_approval_status: 'PENDING',
        parent_approved_at: null,
      })
      .eq('id', orgId);

    if (updateError) {
      logger.error({ error: updateError }, 'Failed to request affiliation');
      res.status(500).json({ error: 'Failed to send affiliation request' });
      return;
    }

    // Audit
    await db.from('audit_events').insert({
      actor_id: userId,
      event_type: 'SUB_ORG_REQUESTED',
      event_category: 'ORG',
      target_type: 'organization',
      target_id: parentOrgId,
      org_id: orgId,
      details: `Requested affiliation with ${parentOrg.display_name}`,
    });

    logger.info({ orgId, parentOrgId }, 'Sub-org affiliation requested');

    res.json({ status: 'PENDING', parentOrgId });
  } catch (error) {
    logger.error({ error }, 'Failed to request affiliation');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/org/sub-orgs/cancel
 *
 * Cancel a pending affiliation request (child org action).
 */
orgSubOrgsRouter.post('/cancel', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { orgId, role } = await getUserOrgInfo(userId);
    if (!orgId) {
      res.status(400).json({ error: 'You must belong to an organization' });
      return;
    }

    if (!isOrgAdmin(role)) {
      res.status(403).json({ error: 'Admin permissions required' });
      return;
    }

    // Check current affiliation status
    const { data: currentOrg } = await db
      .from('organizations')
      .select('parent_org_id, parent_approval_status')
      .eq('id', orgId)
      .single();

    if (!currentOrg?.parent_org_id || currentOrg.parent_approval_status !== 'PENDING') {
      res.status(400).json({ error: 'No pending affiliation request to cancel' });
      return;
    }

    // Clear affiliation
    const { error: updateError } = await db
      .from('organizations')
      .update({
        parent_org_id: null,
        parent_approval_status: null,
        parent_approved_at: null,
      })
      .eq('id', orgId);

    if (updateError) {
      logger.error({ error: updateError }, 'Failed to cancel affiliation');
      res.status(500).json({ error: 'Failed to cancel request' });
      return;
    }

    // Audit
    await db.from('audit_events').insert({
      actor_id: userId,
      event_type: 'SUB_ORG_CANCELLED',
      event_category: 'ORG',
      target_type: 'organization',
      target_id: orgId,
      org_id: orgId,
      details: 'Cancelled pending affiliation request',
    });

    logger.info({ orgId }, 'Sub-org affiliation request cancelled');

    res.json({ status: 'cancelled' });
  } catch (error) {
    logger.error({ error }, 'Failed to cancel affiliation');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/org/sub-orgs/max
 *
 * Update max_sub_orgs setting for parent org.
 * Body: { maxSubOrgs: number | null }
 */
orgSubOrgsRouter.post('/max', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { orgId, role } = await getUserOrgInfo(userId);
    if (!orgId) {
      res.status(400).json({ error: 'You must belong to an organization' });
      return;
    }

    if (!isOrgAdmin(role)) {
      res.status(403).json({ error: 'Admin permissions required' });
      return;
    }

    const { maxSubOrgs } = req.body as { maxSubOrgs?: number | null };
    if (maxSubOrgs !== null && maxSubOrgs !== undefined && (typeof maxSubOrgs !== 'number' || maxSubOrgs < 0)) {
      res.status(400).json({ error: 'maxSubOrgs must be a non-negative number or null' });
      return;
    }

    const { error: updateError } = await db
      .from('organizations')
      .update({ max_sub_orgs: maxSubOrgs ?? null })
      .eq('id', orgId);

    if (updateError) {
      logger.error({ error: updateError }, 'Failed to update max_sub_orgs');
      res.status(500).json({ error: 'Failed to update setting' });
      return;
    }

    logger.info({ orgId, maxSubOrgs }, 'Updated max_sub_orgs');

    res.json({ maxSubOrgs: maxSubOrgs ?? null });
  } catch (error) {
    logger.error({ error }, 'Failed to update max_sub_orgs');
    res.status(500).json({ error: 'Internal server error' });
  }
});
