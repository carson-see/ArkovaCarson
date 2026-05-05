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
 *   POST /api/v1/org/sub-orgs/create   — Parent admin creates an approved affiliate org
 *   POST /api/v1/org/sub-orgs/request  — Request affiliation with a parent org
 *   POST /api/v1/org/sub-orgs/cancel   — Cancel pending affiliation request
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { sendEmail } from '../../email/sender.js';
import { buildInvitationEmail } from '../../email/templates.js';
import { logger } from '../../utils/logger.js';
import { db as _db } from '../../utils/db.js';

// Sub-org columns from migration 0128 are not yet in generated types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = _db as any;

export const orgSubOrgsRouter = Router();

const domainRegex = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;
const optionalDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(255)
  .optional()
  .transform((value) => (value && value.length > 0 ? value : null))
  .refine((value) => value === null || domainRegex.test(value), {
    message: 'domain must be a valid domain name',
  });

const CreateAffiliateOrgSchema = z.object({
  parentOrgId: z.string().uuid().optional(),
  displayName: z.string().trim().min(1).max(255),
  legalName: z.string().trim().min(1).max(255).optional(),
  domain: optionalDomain,
  adminEmail: z.string().trim().toLowerCase().email(),
});

type CreateAffiliateOrgInput = z.infer<typeof CreateAffiliateOrgSchema>;

interface RouteFailure {
  ok: false;
  status: number;
  error: string;
}

interface RouteSuccess<T> {
  ok: true;
  value: T;
}

type RouteResult<T> = RouteSuccess<T> | RouteFailure;

interface ParentContext {
  orgId: string;
}

interface AdminProfile {
  id: string;
  email: string;
  full_name: string | null;
}

interface ChildOrg {
  id: string;
  display_name: string;
  domain: string | null;
  verification_status: string;
  parent_approval_status: string;
  created_at: string;
  logo_url: string | null;
}

function routeSuccess<T>(value: T): RouteSuccess<T> {
  return { ok: true, value };
}

function routeFailure(status: number, error: string): RouteFailure {
  return { ok: false, status, error };
}

/** Helper to get userId from request */
function getUserId(req: Request): string | undefined {
  return (req as unknown as { userId?: string }).userId;
}

/** Helper to get user's org_id and role */
async function getUserOrgInfo(
  userId: string,
  preferredOrgId?: string,
): Promise<{ orgId: string | null; role: string | null }> {
  const query = db
    .from('org_members')
    .select('org_id, role')
    .eq('user_id', userId);

  const { data } = await (preferredOrgId
    ? query.eq('org_id', preferredOrgId).maybeSingle()
    : query.limit(1).maybeSingle());

  return { orgId: data?.org_id ?? null, role: data?.role ?? null };
}

/** Check if user is admin/owner of their org */
function isOrgAdmin(role: string | null): boolean {
  return role === 'owner' || role === 'admin';
}

async function cleanupCreatedOrg(childOrgId: string): Promise<void> {
  try {
    await db.from('organizations').delete().eq('id', childOrgId);
  } catch (error) {
    logger.warn({ error, childOrgId }, 'Failed to clean up partially-created affiliate org');
  }
}

async function resolveAffiliateParentContext(
  userId: string,
  parentOrgId?: string,
): Promise<RouteResult<ParentContext>> {
  const { orgId, role } = await getUserOrgInfo(userId, parentOrgId);
  if (!orgId) {
    return routeFailure(
      parentOrgId ? 403 : 400,
      parentOrgId
        ? 'You are not a member of the selected parent organization'
        : 'You must belong to an organization',
    );
  }

  if (!isOrgAdmin(role)) {
    return routeFailure(403, 'Admin permissions required');
  }

  const { data: parentOrg, error: parentError } = await db
    .from('organizations')
    .select('id, display_name, verification_status, parent_org_id')
    .eq('id', orgId)
    .single();

  if (parentError || !parentOrg) {
    return routeFailure(404, 'Parent organization not found');
  }

  if (parentOrg.verification_status !== 'VERIFIED') {
    return routeFailure(400, 'Only verified organizations can create affiliates');
  }

  if (parentOrg.parent_org_id) {
    return routeFailure(400, 'Affiliate organizations cannot create affiliates');
  }

  return routeSuccess({ orgId });
}

async function lookupAffiliateAdmin(email: string): Promise<RouteResult<AdminProfile | null>> {
  const { data: adminProfile, error: adminError } = await db
    .from('profiles')
    .select('id, email, full_name')
    .eq('email', email)
    .maybeSingle();

  if (adminError) {
    logger.error({ error: adminError }, 'Failed to look up affiliate admin');
    return routeFailure(500, 'Failed to look up affiliate admin');
  }

  return routeSuccess(adminProfile ?? null);
}

async function createAffiliateOrg(
  parentOrgId: string,
  input: CreateAffiliateOrgInput,
): Promise<RouteResult<ChildOrg>> {
  const legalName = input.legalName?.trim() || input.displayName;
  const { data: childOrg, error: createError } = await db
    .from('organizations')
    .insert({
      display_name: input.displayName,
      legal_name: legalName,
      domain: input.domain,
      verification_status: 'UNVERIFIED',
      parent_org_id: parentOrgId,
      parent_approval_status: 'APPROVED',
      parent_approved_at: new Date().toISOString(),
    })
    .select('id, display_name, domain, verification_status, parent_approval_status, created_at, logo_url')
    .single();

  if (createError || !childOrg) {
    logger.error({ error: createError }, 'Failed to create affiliate org');
    return routeFailure(500, 'Failed to create affiliate organization');
  }

  return routeSuccess(childOrg);
}

function buildAffiliateMembershipRows(
  userId: string,
  childOrgId: string,
  adminProfile: AdminProfile | null,
) {
  const membershipRows = [
    {
      user_id: userId,
      org_id: childOrgId,
      role: 'owner',
      invited_by: userId,
    },
  ];

  if (adminProfile && adminProfile.id !== userId) {
    membershipRows.push({
      user_id: adminProfile.id,
      org_id: childOrgId,
      role: 'admin',
      invited_by: userId,
    });
  }

  return membershipRows;
}

async function assignAffiliateAdmins(
  userId: string,
  childOrgId: string,
  adminProfile: AdminProfile | null,
): Promise<RouteResult<void>> {
  const membershipRows = buildAffiliateMembershipRows(userId, childOrgId, adminProfile);
  // eslint-disable-next-line arkova/missing-org-filter -- scoped insert: childOrg was created under verified parentOrg + parent-admin gate above.
  const { error: memberError } = await db.from('org_members').insert(membershipRows);
  if (memberError) {
    logger.error({ error: memberError, childOrgId }, 'Failed to assign affiliate org admins');
    return routeFailure(500, 'Failed to assign affiliate organization admins');
  }

  return routeSuccess(undefined);
}

async function initializeAffiliateCredits(childOrgId: string): Promise<RouteResult<void>> {
  const { error: creditError } = await db.from('org_credits').insert({ org_id: childOrgId });
  if (creditError) {
    logger.error({ error: creditError, childOrgId }, 'Failed to initialize affiliate org credits');
    return routeFailure(500, 'Failed to initialize affiliate organization credits');
  }

  return routeSuccess(undefined);
}

async function maybeCreateAffiliateAdminInvitation(
  userId: string,
  childOrgId: string,
  input: CreateAffiliateOrgInput,
  adminProfile: AdminProfile | null,
): Promise<RouteResult<string | null>> {
  if (adminProfile) {
    return routeSuccess(null);
  }

  const { data: invitation, error: invitationError } = await db
    .from('invitations')
    .insert({
      email: input.adminEmail,
      role: 'ORG_ADMIN',
      org_id: childOrgId,
      invited_by: userId,
    })
    .select('id')
    .single();

  if (invitationError || !invitation) {
    logger.error({ error: invitationError, childOrgId }, 'Failed to invite affiliate org admin');
    return routeFailure(500, 'Failed to invite affiliate organization admin');
  }

  return routeSuccess(invitation.id);
}

async function auditAffiliateCreation(
  userId: string,
  parentOrgId: string,
  childOrgId: string,
  adminProfile: AdminProfile | null,
  invitationId: string | null,
): Promise<RouteResult<void>> {
  const { error: auditError } = await db.from('audit_events').insert({
    actor_id: userId,
    event_type: 'SUB_ORG_CREATED',
    event_category: 'ORG',
    target_type: 'organization',
    target_id: childOrgId,
    org_id: parentOrgId,
    details: JSON.stringify({
      parent_org_id: parentOrgId,
      affiliate_org_id: childOrgId,
      affiliate_admin_user_id: adminProfile?.id ?? null,
      affiliate_admin_invitation_id: invitationId,
    }),
  });

  if (auditError) {
    logger.error({ error: auditError, childOrgId }, 'Failed to audit affiliate org creation');
    return routeFailure(500, 'Failed to audit affiliate organization creation');
  }

  return routeSuccess(undefined);
}

async function maybeSendAffiliateAdminInvitationEmail(
  userId: string,
  childOrg: ChildOrg,
  input: CreateAffiliateOrgInput,
  invitationId: string | null,
): Promise<boolean | null> {
  if (!invitationId) {
    return null;
  }

  try {
    const inviteUrl = `${config.frontendUrl}/login?invite=true&org=${encodeURIComponent(childOrg.id)}`;
    const { subject, html } = buildInvitationEmail({
      recipientEmail: input.adminEmail,
      organizationName: childOrg.display_name,
      role: 'ORG_ADMIN',
      inviteUrl,
    });
    const emailResult = await sendEmail({
      to: input.adminEmail,
      subject,
      html,
      emailType: 'invitation',
      actorId: userId,
      orgId: childOrg.id,
    });

    if (!emailResult.success) {
      logger.warn(
        { childOrgId: childOrg.id, error: emailResult.error },
        'Affiliate admin invitation email failed after invitation creation',
      );
    }

    return emailResult.success;
  } catch (emailError) {
    logger.warn(
      { childOrgId: childOrg.id, error: emailError },
      'Affiliate admin invitation email threw after invitation creation',
    );
    return false;
  }
}

async function cleanupAndSendFailure(
  res: Response,
  childOrgId: string,
  failure: RouteFailure,
): Promise<void> {
  await cleanupCreatedOrg(childOrgId);
  res.status(failure.status).json({ error: failure.error });
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

    const requestedOrgId = typeof req.query.orgId === 'string' ? req.query.orgId : undefined;
    const { orgId } = await getUserOrgInfo(userId, requestedOrgId);
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
 * POST /api/v1/org/sub-orgs/create
 *
 * Verified parent org admin creates an immediately-approved affiliate org
 * and assigns or invites the affiliate admin. The parent
 * admin is also added as owner of the affiliate so they can administer it
 * without granting the affiliate admin any privileges on the parent org.
 * Body: { parentOrgId?: string, displayName: string, legalName?: string, domain?: string, adminEmail: string }
 */
orgSubOrgsRouter.post('/create', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const parsed = CreateAffiliateOrgSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid affiliate organization details' });
      return;
    }

    const parentContext = await resolveAffiliateParentContext(userId, parsed.data.parentOrgId);
    if (!parentContext.ok) {
      res.status(parentContext.status).json({ error: parentContext.error });
      return;
    }

    const adminLookup = await lookupAffiliateAdmin(parsed.data.adminEmail);
    if (!adminLookup.ok) {
      res.status(adminLookup.status).json({ error: adminLookup.error });
      return;
    }

    const { orgId } = parentContext.value;
    const adminProfile = adminLookup.value;
    const createResult = await createAffiliateOrg(orgId, parsed.data);
    if (!createResult.ok) {
      res.status(createResult.status).json({ error: createResult.error });
      return;
    }

    const childOrg = createResult.value;
    const adminAssignment = await assignAffiliateAdmins(userId, childOrg.id, adminProfile);
    if (!adminAssignment.ok) {
      await cleanupAndSendFailure(res, childOrg.id, adminAssignment);
      return;
    }

    const creditSetup = await initializeAffiliateCredits(childOrg.id);
    if (!creditSetup.ok) {
      await cleanupAndSendFailure(res, childOrg.id, creditSetup);
      return;
    }

    const invitationResult = await maybeCreateAffiliateAdminInvitation(userId, childOrg.id, parsed.data, adminProfile);
    if (!invitationResult.ok) {
      await cleanupAndSendFailure(res, childOrg.id, invitationResult);
      return;
    }

    const invitationId = invitationResult.value;
    const auditResult = await auditAffiliateCreation(userId, orgId, childOrg.id, adminProfile, invitationId);
    if (!auditResult.ok) {
      await cleanupAndSendFailure(res, childOrg.id, auditResult);
      return;
    }

    const invitationEmailSent = await maybeSendAffiliateAdminInvitationEmail(
      userId,
      childOrg,
      parsed.data,
      invitationId,
    );

    logger.info({ orgId, childOrgId: childOrg.id }, 'Affiliate org created');

    res.status(201).json({
      affiliateOrg: childOrg,
      parentOrgId: orgId,
      affiliateAdmin: adminProfile
        ? {
            status: 'assigned',
            id: adminProfile.id,
            email: adminProfile.email,
            fullName: adminProfile.full_name,
          }
        : {
            status: 'invited',
            id: null,
            email: parsed.data.adminEmail,
            fullName: null,
            invitationId,
            invitationEmailSent,
          },
    });
  } catch (error) {
    logger.error({ error }, 'Failed to create affiliate org');
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

    const { childOrgId, parentOrgId } = req.body as { childOrgId?: string; parentOrgId?: string };
    const { orgId, role } = await getUserOrgInfo(userId, parentOrgId);
    if (!orgId) {
      res.status(parentOrgId ? 403 : 400).json({
        error: parentOrgId
          ? 'You are not a member of the selected parent organization'
          : 'You must belong to an organization',
      });
      return;
    }

    if (!isOrgAdmin(role)) {
      res.status(403).json({ error: 'Admin permissions required' });
      return;
    }

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

    const { childOrgId, parentOrgId } = req.body as { childOrgId?: string; parentOrgId?: string };
    const { orgId, role } = await getUserOrgInfo(userId, parentOrgId);
    if (!orgId) {
      res.status(parentOrgId ? 403 : 400).json({
        error: parentOrgId
          ? 'You are not a member of the selected parent organization'
          : 'You must belong to an organization',
      });
      return;
    }

    if (!isOrgAdmin(role)) {
      res.status(403).json({ error: 'Admin permissions required' });
      return;
    }

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
