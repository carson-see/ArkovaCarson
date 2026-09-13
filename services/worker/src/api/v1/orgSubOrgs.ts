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
import { callRpc } from '../../utils/rpc.js';
import {
  resolveParentAdminOrg,
  subOrgAuditActor,
  type SubOrgCaller,
} from './orgSubOrgsCaller.js';

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

const AffiliateActionSchema = z.object({
  childOrgId: z.string().uuid(),
  parentOrgId: z.string().uuid().optional(),
});

type CreateAffiliateOrgInput = z.infer<typeof CreateAffiliateOrgSchema>;

interface RouteFailure {
  ok: false;
  status: number;
  /**
   * The human-readable half. The JWT dashboard mount sends this verbatim and
   * has done since SCRUM-3865, so it is frozen there by its own consumers.
   */
  error: string;
  /**
   * The machine-readable half (review U6). The API-key mount is a PUBLISHED,
   * §1.8-frozen surface: an English sentence in `error` is not something an
   * integration can branch on, and "Affiliated-organization limit reached (3 of
   * 3)." would freeze a count into the contract. Every failure a key caller can
   * reach carries a code; the key mount sends the code (and its own status for
   * it) while the JWT mount keeps the prose and the status it has always sent.
   */
  code?: string;
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

interface AffiliateActionChildOrg {
  id: string;
  parent_org_id: string | null;
  parent_approval_status: string | null;
  display_name: string;
}

export interface AffiliateActionContext {
  caller: SubOrgCaller;
  orgId: string;
  childOrgId: string;
  childOrg: AffiliateActionChildOrg;
}

export interface AffiliateActionSpec {
  targetStatus: 'APPROVED' | 'REVOKED';
  alreadyStatusError: string;
  /** Machine code for `alreadyStatusError` on the published key surface (U6). */
  alreadyStatusCode: 'already_approved' | 'already_revoked';
  updateFailureError: string;
  auditEventType: 'SUB_ORG_APPROVED' | 'SUB_ORG_REVOKED';
  auditVerb: 'Approved' | 'Revoked';
  successLog: string;
  failureLog: string;
}

function routeSuccess<T>(value: T): RouteSuccess<T> {
  return { ok: true, value };
}

function routeFailure(status: number, error: string, code?: string): RouteFailure {
  return code === undefined ? { ok: false, status, error } : { ok: false, status, error, code };
}

/** SCRUM-4467: distinguish definitive cap rejection from retryable write conflicts. */
function subOrgCapWriteFailure(error: { code?: string; message?: string } | null): RouteFailure | null {
  if (error?.code === '23514' && error.message === 'sub_org_limit_reached') {
    return routeFailure(409, 'sub_org_limit_reached', 'sub_org_limit_reached');
  }
  // Lock waits and transaction conflicts are retryable, never successful writes.
  if (error?.code && ['55P03', '40001', '40P01'].includes(error.code)) {
    return routeFailure(503, 'cap_check_unavailable', 'cap_check_unavailable');
  }
  return null;
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

/**
 * Platform cap on sub-organizations per parent (Carson, 2026-09-01).
 *
 * `organizations.max_sub_orgs` already existed, was settable via POST /max and
 * was returned by the list endpoint — and was checked by NOTHING, so a parent
 * could create unlimited affiliates. This is the fallback when an org carries
 * no explicit override; the override still wins in either direction.
 */
export const DEFAULT_MAX_SUB_ORGS = 20;

export interface SubOrgCap {
  ok: boolean;
  limit: number;
  current: number;
  /** The count could not be read — refuse rather than guess. */
  unavailable?: boolean;
}

/**
 * How many sub-orgs may this parent still add?
 *
 * FAILS CLOSED. Unlike the credit-enforcement lookup, a read failure here must
 * refuse: guessing would let a parent walk straight past the cap during a
 * database blip, and the cost of refusing is one retry.
 *
 * `?? DEFAULT` and not `|| DEFAULT` is load-bearing — an org explicitly capped
 * at 0 must stay at 0, not silently inherit the full default.
 */
export async function resolveSubOrgCap(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  database: any,
  parentOrgId: string,
): Promise<SubOrgCap> {
  const { data: org, error: parentError } = await database
    .from('organizations')
    .select('max_sub_orgs')
    .eq('id', parentOrgId)
    .maybeSingle();

  if (parentError || !org) {
    logger.error({ err: parentError?.message, parentOrgId }, 'suborg_cap_parent_lookup_failed');
    return { ok: false, limit: -1, current: -1, unavailable: true };
  }

  const limit: number = org.max_sub_orgs ?? DEFAULT_MAX_SUB_ORGS;

  // Deliberately NOT a PostgREST head-only exact-count select (R0-8 / SCRUM-1254):
  // PostgREST's exact count is the pattern that produced 60 s statement
  // timeouts on hot tables, and `organizations` is one of them. This filter is
  // an indexed equality on `parent_org_id` returning at most a handful of rows
  // — the cap is 20 — so selecting the ids and taking `.length` is both exact
  // and cheaper than asking the planner for a count.
  //
  // It stays UNBOUNDED on purpose. `current` is surfaced in the API response
  // below, and a `.limit(cap)` would silently under-report whenever an admin
  // lowers `max_sub_orgs` beneath the number of children already approved —
  // exactly the case an operator needs to see accurately.
  const { data: children, error } = await database
    .from('organizations')
    .select('id')
    .eq('parent_org_id', parentOrgId)
    .eq('parent_approval_status', 'APPROVED');

  if (error || !Array.isArray(children)) {
    logger.error({ err: error?.message, parentOrgId }, 'suborg_cap_count_failed');
    return { ok: false, limit, current: -1, unavailable: true };
  }

  const current = children.length;
  return { ok: current < limit, limit, current };
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
    const capFailure = subOrgCapWriteFailure(createError);
    if (capFailure) return capFailure;
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

async function resolveAffiliateActionContext(
  userId: string,
  body: unknown,
): Promise<RouteResult<AffiliateActionContext>> {
  const parsed = AffiliateActionSchema.safeParse(body);
  if (!parsed.success) {
    return routeFailure(400, 'Invalid sub-organization action details');
  }

  const { childOrgId, parentOrgId } = parsed.data;
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

  const { data: childOrg, error: fetchError } = await db
    .from('organizations')
    .select('id, parent_org_id, parent_approval_status, display_name')
    .eq('id', childOrgId)
    .single();

  if (fetchError || !childOrg) {
    return routeFailure(404, 'Organization not found');
  }

  if (childOrg.parent_org_id !== orgId) {
    return routeFailure(403, 'This organization is not affiliated with yours');
  }

  return routeSuccess({
    caller: { kind: 'user', userId, orgId },
    orgId,
    childOrgId,
    childOrg,
  });
}

function buildAffiliateStatusUpdate(status: AffiliateActionSpec['targetStatus']) {
  if (status === 'APPROVED') {
    return {
      parent_approval_status: status,
      parent_approved_at: new Date().toISOString(),
    };
  }

  return { parent_approval_status: status };
}

async function updateAffiliateStatus(
  context: AffiliateActionContext,
  action: AffiliateActionSpec,
): Promise<RouteResult<void>> {
  if (context.childOrg.parent_approval_status === action.targetStatus) {
    return routeFailure(400, action.alreadyStatusError, action.alreadyStatusCode);
  }

  // D3 — the cap applies to BOTH paths that add a sub-org. Approving a pending
  // request is one of them; enforcing only on create would leave a cap you can
  // walk around by asking to be affiliated instead of being created.
  if (action.targetStatus === 'APPROVED') {
    const cap = await resolveSubOrgCap(db, context.orgId);
    if (!cap.ok) {
      return routeFailure(
        cap.unavailable ? 503 : 409,
        cap.unavailable
          ? 'Could not verify the affiliated-organization limit. Try again.'
          : `Affiliated-organization limit reached (${cap.current} of ${cap.limit}).`,
        cap.unavailable ? 'cap_check_unavailable' : 'sub_org_limit_reached',
      );
    }
  }

  // SCRUM-4468: bind the write to the affiliation we authorized. A concurrent reparent or
  // status transition must not turn this into a write against another tenant.
  const update = db
    .from('organizations')
    .update(buildAffiliateStatusUpdate(action.targetStatus))
    .eq('id', context.childOrgId)
    .eq('parent_org_id', context.orgId);
  const scopedUpdate = context.childOrg.parent_approval_status === null
    ? update.is('parent_approval_status', null)
    : update.eq('parent_approval_status', context.childOrg.parent_approval_status);
  const { data: updatedOrg, error: updateError } = await scopedUpdate.select('id').maybeSingle();

  if (updateError) {
    const capFailure = subOrgCapWriteFailure(updateError);
    if (capFailure) return capFailure;
    logger.error({ error: updateError }, action.failureLog);
    return routeFailure(500, action.updateFailureError, 'status_update_failed');
  }
  if (!updatedOrg) {
    return routeFailure(409, 'Affiliation changed. Refresh and try again.', 'affiliation_changed');
  }

  return routeSuccess(undefined);
}

/**
 * SCRUM-3971 (R13). `details` was a prose sentence — fine while the only actor
 * was a logged-in user whose id sat in `actor_id`, useless once an API key can
 * act: `audit_events.actor_id` is `REFERENCES public.profiles(id)`, so a key
 * has nothing it can legally put there, and the sentence had nowhere to record
 * which key acted. JSON with an `actor` block carries it.
 *
 * **Who actually reads `audit_events.details`** (grepped, review U5 — an earlier
 * version of this comment named a `renderAuditDetails` fallback in
 * `audit-export.ts`; no such symbol exists and `audit-export.ts` exports
 * ANCHORS, not audit events):
 *
 *   - `audit/cloud-logging-sink.ts:127` `safeParseDetails` — `JSON.parse` with a
 *     `{ raw }` fallback, so it handles both shapes. Prose rows keep flowing.
 *   - `api/account-export.ts:126` — the GDPR subject-access export selects
 *     `details` and emits it VERBATIM, with no parse. A user's own export
 *     therefore now shows a JSON string rather than an English sentence for the
 *     four `SUB_ORG_*` events they authored. Accepted and documented: the
 *     export is a faithful copy of the stored column, the JSON is
 *     self-describing, and it carries strictly MORE than the sentence did.
 *     Key-driven rows have `actor_id = NULL` and so never appear in any user's
 *     subject-access export at all.
 *
 * Historical prose rows are left exactly as they are.
 *
 * **The insert error is NOT discarded (review U4).** It used to be: the write
 * was fire-and-forget, so approve/revoke answered 200 with no audit record
 * whenever the insert failed. On the key path that is worse than on the JWT
 * path — `actor_id` is NULL by construction there, so `details.actor` is the
 * only attribution that exists. A failure now answers `500 audit_write_failed`
 * on BOTH mounts. The status change is already committed at that point and
 * cannot be undone from here, so the error names the audit write specifically
 * rather than pretending the action failed; a retry is safe and answers
 * `already_approved` / `already_revoked`.
 */
async function auditAffiliateStatus(
  context: AffiliateActionContext,
  action: AffiliateActionSpec,
): Promise<RouteResult<void>> {
  const { actorId, actor } = subOrgAuditActor(context.caller);
  const { error: auditError } = await db.from('audit_events').insert({
    actor_id: actorId,
    event_type: action.auditEventType,
    event_category: 'ORG',
    target_type: 'organization',
    target_id: context.childOrgId,
    org_id: context.orgId,
    details: JSON.stringify({
      action: action.auditVerb.toLowerCase(),
      summary: `${action.auditVerb} sub-org affiliation: ${context.childOrg.display_name}`,
      parent_org_id: context.orgId,
      child_org_id: context.childOrgId,
      child_display_name: context.childOrg.display_name,
      actor,
    }),
  });

  if (auditError) {
    // The status HAS already changed — this is a separate statement, not the
    // same transaction, and there is nothing to roll back into. Reporting 200
    // anyway would be the worse answer: on the key path `actor_id` is NULL by
    // construction, so `details.actor` is the ONLY record of which key acted,
    // and a silently-missing row is an affiliation that changed with no
    // attributable actor at all. 0453's `suspend_suborg_as_api_key` makes the
    // same call the only way SQL can — it fails the transaction.
    logger.error(
      { error: auditError, orgId: context.orgId, childOrgId: context.childOrgId, event: action.auditEventType },
      'suborg_status_audit_write_failed',
    );
    return routeFailure(500, 'audit_write_failed', 'audit_write_failed');
  }

  return routeSuccess(undefined);
}

/**
 * The approve / revoke transition, shared by the JWT mount and the API-key
 * mount (SCRUM-3971 R9). Everything mount-specific — how the caller was
 * identified, how the child was named, what the response looks like — stays
 * with the mount; the compare-and-set write and its audit row live here once.
 */
export async function applyAffiliateStatusAction(
  context: AffiliateActionContext,
  action: AffiliateActionSpec,
): Promise<RouteResult<void>> {
  const updateResult = await updateAffiliateStatus(context, action);
  if (!updateResult.ok) return updateResult;

  const auditResult = await auditAffiliateStatus(context, action);
  if (!auditResult.ok) return auditResult;

  logger.info({ orgId: context.orgId, childOrgId: context.childOrgId }, action.successLog);
  return routeSuccess(undefined);
}

async function handleAffiliateStatusAction(
  req: Request,
  res: Response,
  action: AffiliateActionSpec,
): Promise<void> {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const context = await resolveAffiliateActionContext(userId, req.body);
    if (!context.ok) {
      res.status(context.status).json({ error: context.error });
      return;
    }

    const actionResult = await applyAffiliateStatusAction(context.value, action);
    if (!actionResult.ok) {
      res.status(actionResult.status).json({ error: actionResult.error });
      return;
    }

    res.json({ status: action.targetStatus, childOrgId: context.value.childOrgId });
  } catch (error) {
    logger.error({ error }, action.failureLog);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export const APPROVE_AFFILIATE_ACTION: AffiliateActionSpec = {
  targetStatus: 'APPROVED',
  alreadyStatusError: 'Organization is already approved',
  alreadyStatusCode: 'already_approved',
  updateFailureError: 'Failed to approve organization',
  auditEventType: 'SUB_ORG_APPROVED',
  auditVerb: 'Approved',
  successLog: 'Sub-org approved',
  failureLog: 'Failed to approve sub-org',
};

export const REVOKE_AFFILIATE_ACTION: AffiliateActionSpec = {
  targetStatus: 'REVOKED',
  alreadyStatusError: 'Affiliation is already revoked',
  alreadyStatusCode: 'already_revoked',
  updateFailureError: 'Failed to revoke affiliation',
  auditEventType: 'SUB_ORG_REVOKED',
  auditVerb: 'Revoked',
  successLog: 'Sub-org revoked',
  failureLog: 'Failed to revoke sub-org',
};

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

    // SCRUM-3867 — which sub-orgs currently run on THIS org's DocuSign
    // connection. One query for the whole list rather than a per-row endpoint,
    // and an additive field (§1.8) so existing consumers are untouched. A
    // failure here degrades to "no sub-org is inheriting" rather than taking
    // out the list: the toggle is additive to a panel that already worked.
    const childIds = (subOrgs ?? []).map((s: { id: string }) => s.id);
    let inheritingIds = new Set<string>();
    if (childIds.length > 0) {
      // Doubly tenant-scoped: `inherited_from_org_id = orgId` restricts to
      // markers pointing at THIS org, and `in('org_id', childIds)` restricts to
      // its own children. The isolation rule matches only a literal
      // `.eq('org_id', ...)`, so the disable sits on the chain it flags.
      // eslint-disable-next-line arkova/missing-org-filter -- see the note above
      const { data: markers, error: markerError } = await db
        .from('org_integrations')
        .select('org_id')
        .eq('provider', 'docusign')
        .eq('inherited_from_org_id', orgId)
        .is('revoked_at', null)
        .in('org_id', childIds);
      if (markerError) {
        logger.error({ err: markerError.message, orgId }, 'suborg_docusign_marker_lookup_failed');
      } else {
        inheritingIds = new Set((markers ?? []).map((m: { org_id: string }) => m.org_id));
      }
    }

    res.json({
      subOrgs: (subOrgs ?? []).map((s: { id: string }) => ({
        ...s,
        docusignInherited: inheritingIds.has(s.id),
      })),
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

    // D3 — refuse before creating anything. `max_sub_orgs` was settable and
    // displayed but checked by nothing, so this cap did not exist in practice.
    const cap = await resolveSubOrgCap(db, orgId);
    if (!cap.ok) {
      res.status(cap.unavailable ? 503 : 409).json({
        error: cap.unavailable ? 'cap_check_unavailable' : 'sub_org_limit_reached',
        limit: cap.limit,
        current: cap.current,
      });
      return;
    }

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
 * Body: { childOrgId: string, parentOrgId?: string }
 */
orgSubOrgsRouter.post('/approve', async (req: Request, res: Response) => {
  await handleAffiliateStatusAction(req, res, APPROVE_AFFILIATE_ACTION);
});

/**
 * POST /api/v1/org/sub-orgs/revoke
 *
 * Parent org admin revokes an approved sub-org affiliation.
 * Body: { childOrgId: string, parentOrgId?: string }
 */
orgSubOrgsRouter.post('/revoke', async (req: Request, res: Response) => {
  await handleAffiliateStatusAction(req, res, REVOKE_AFFILIATE_ACTION);
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
      details: JSON.stringify({
        action: 'requested',
        summary: `Requested affiliation with ${parentOrg.display_name}`,
        parent_org_id: parentOrgId,
        child_org_id: orgId,
        parent_display_name: parentOrg.display_name,
        actor: subOrgAuditActor({ kind: 'user', userId, orgId }).actor,
      }),
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
      details: JSON.stringify({
        action: 'cancelled',
        summary: 'Cancelled pending affiliation request',
        child_org_id: orgId,
        actor: subOrgAuditActor({ kind: 'user', userId, orgId }).actor,
      }),
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

// ─── Sub-org credit provisioning (SCRUM-3865) ────────────────────────────────
//
// Pre-mortem F3: `allocate_credits_to_sub_org` existed, was correct, and had
// ZERO callers anywhere in the repository — `org_credit_allocations` had never
// had a row in production. These two endpoints are the missing path, and they
// are the only way a parent admin can fund or defund a sub-org.
//
// Both call migration 0430's identity-carrying overload, because `auth.uid()`
// is NULL under the worker's service_role client and the pre-0430 overloads
// therefore returned `authentication_required` on every worker call.
//
// The caller id sent to the RPC is ALWAYS the verified session user. It is
// never read from the request body: a client that could choose it could move
// another organization's credits. The org-admin check below is a fast local
// pre-check — the RPC independently re-verifies parent adminship and that the
// child really is a sub-org of that parent, so authorization does not depend on
// this layer being correct.

/**
 * `suspend_suborg` / `suspend_suborg_as_api_key` error code -> HTTP status.
 *
 * Anything unlisted is `RPC_UNEXPECTED_STATUS` (502), NOT 500: an unmapped code
 * is a structured refusal the RPC chose to return, so the request did not fail
 * *here* — it was answered by an upstream we do not have a mapping for. A 500
 * tells an integrator "retry, this is our bug"; a 502 tells them "the call was
 * refused for a reason this version does not name", which is what actually
 * happened and is what the key surface needs when SQL grows a new code before
 * the worker learns it (review U7).
 */
const SUSPEND_RPC_STATUS: Record<string, number> = {
  unauthenticated: 401,
  parent_admin_required: 403,
  not_a_child_of_parent: 404,
  // 0453. `api_keys.created_by` is NOT NULL, so this is unreachable for a key
  // that exists; it fires only if that column ever becomes nullable. 503, not
  // 403: the key IS authorized, the RPC just could not resolve the principal
  // it must stamp on the row — an operational gap, and a retry is meaningful.
  api_key_principal_unresolved: 503,
};

/** See SUSPEND_RPC_STATUS: an unmapped structured refusal is upstream, not ours. */
const RPC_UNEXPECTED_STATUS = 502;

/** Credits are whole units; the bound is a sanity rail, not a business limit. */
export const MAX_CREDIT_TRANSFER = 100_000_000;

const AllocateCreditsSchema = z.object({
  childOrgId: z.string().uuid(),
  // Negative = reclaim from the sub-org back to the parent (offboarding).
  amount: z
    .number()
    .int()
    .refine((n) => n !== 0, { message: 'amount must be non-zero' })
    .refine((n) => Math.abs(n) <= MAX_CREDIT_TRANSFER, {
      message: `amount must be within +/-${MAX_CREDIT_TRANSFER}`,
    }),
  note: z.string().trim().max(500).optional(),
});

interface AllocateCreditsRpcResult {
  success?: boolean;
  parent_balance?: number;
  child_balance?: number;
  error?: string;
}

export interface CreditRollupRpcResult {
  parent_org_id?: string;
  parent_balance?: number;
  children?: {
    child_org_id: string;
    /** Added by migration 0453's `*_as_api_key` sibling; absent on the user overload. */
    child_public_id?: string | null;
    balance: number;
    monthly_allocation: number;
  }[];
  error?: string;
}

/** RPC error code -> HTTP status. Anything unlisted is a 500.
 *
 * NOT `mapRpcErrorToStatus` (api/rpc-error-status.ts): that maps RAISEd
 * exception MESSAGES by substring match. These two RPCs return structured
 * `{ error: '<code>' }` jsonb instead of raising, so an exact-code lookup is
 * the right shape and substring matching would be guesswork. */
const CREDIT_RPC_STATUS: Record<string, number> = {
  authentication_required: 401,
  parent_admin_required: 403,
  not_a_sub_org: 404,
  // 409 rather than 402: the request conflicts with the current balance, and
  // unlike the anchor path nothing here is purchasable in the moment.
  insufficient_parent_balance: 409,
  insufficient_child_balance: 409,
  // 0453 — see SUSPEND_RPC_STATUS for why this is a 503 (review U7).
  api_key_principal_unresolved: 503,
};

/**
 * Resolves the acting parent org and rejects non-admins.
 *
 * `getUserOrgInfo` without an explicit org does `.limit(1).maybeSingle()` with
 * no ORDER BY, so it returns an ARBITRARY one of the caller's memberships. That
 * is tolerable for a list endpoint and NOT tolerable here: the affiliate flow
 * writes the parent admin into every child's `org_members` as `owner`, so a
 * HakiChain admin belongs to HakiChain *and* to each client org, and the org
 * this resolved to would decide which balance a transfer debits. When the
 * caller is ambiguous we make them say which org, rather than guessing on a
 * money-moving path.
 *
 * The resolution itself now lives in `orgSubOrgsCaller.ts` so the JWT mount and
 * the API-key mount cannot drift, and so the SCRUM-5031 profile-only ORG_ADMIN
 * fix exists in one place. The status codes and bodies this route returns are
 * unchanged.
 */
async function requireParentAdmin(
  req: Request,
  res: Response,
): Promise<{ userId: string; orgId: string } | null> {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }

  const requestedOrgId = typeof req.query.orgId === 'string' ? req.query.orgId : undefined;
  const resolved = await resolveParentAdminOrg(userId, requestedOrgId, db);
  if (!resolved.ok) {
    const body: Record<string, string> = { error: resolved.error };
    if (resolved.message) body.message = resolved.message;
    res.status(resolved.status).json(body);
    return null;
  }

  return { userId, orgId: resolved.value };
}

/**
 * Which credit RPC a caller reaches, and with which identity argument.
 *
 * A user caller reaches migration 0430/0444's `p_caller_user_id` overload; an
 * API-key caller reaches migration 0453's distinctly-named `*_as_api_key`
 * sibling. NOT an overload of the same name (R2): PostgREST resolves overloads
 * by argument NAMES, and two same-arity signatures differing only in the
 * identity argument is an ambiguity waiting for the first caller that omits an
 * optional argument.
 */
function creditRpcName(caller: SubOrgCaller): string {
  return caller.kind === 'api_key'
    ? 'allocate_credits_to_sub_org_as_api_key'
    : 'allocate_credits_to_sub_org';
}

function callerRpcArg(caller: SubOrgCaller): Record<string, string> {
  return caller.kind === 'api_key'
    ? { p_caller_api_key_id: caller.apiKeyId }
    : { p_caller_user_id: caller.userId };
}

export interface SubOrgCoreResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Credit allocation, shared by both mounts (R9). Positive allocates, negative
 * reclaims. `childOrgId` is already resolved and authorized as far as the route
 * layer can — the RPC re-verifies parent authority under `FOR UPDATE`, which is
 * where authority actually lives.
 */
export async function allocateSubOrgCreditsCore(
  caller: SubOrgCaller,
  childOrgId: string,
  amount: number,
  note: string | null,
): Promise<SubOrgCoreResponse> {
  const { data, error } = await callRpc<AllocateCreditsRpcResult>(db, creditRpcName(caller), {
    p_parent_org_id: caller.orgId,
    p_child_org_id: childOrgId,
    p_amount: amount,
    p_note: note,
    ...callerRpcArg(caller),
  });

  if (error) {
    logger.error({ err: error.message, orgId: caller.orgId }, 'suborg_credit_allocation_rpc_failure');
    return { status: 503, body: { error: 'credit_allocation_unavailable' } };
  }

  if (!data || data.error) {
    const code = data?.error ?? 'unknown_error';
    return { status: CREDIT_RPC_STATUS[code] ?? RPC_UNEXPECTED_STATUS, body: { error: code } };
  }

  logger.info(
    { orgId: caller.orgId, childOrgId, amount, actorKind: caller.kind },
    amount > 0 ? 'suborg_credits_allocated' : 'suborg_credits_reclaimed',
  );

  return {
    status: 200,
    body: {
      parentBalance: data.parent_balance,
      childBalance: data.child_balance,
      amount,
    },
  };
}

/** Raw rollup rows for either mount; each mount applies its own serializer. */
export async function subOrgCreditRollupCore(
  caller: SubOrgCaller,
): Promise<{ status: number; body?: Record<string, unknown>; rollup?: CreditRollupRpcResult }> {
  const rpcName = caller.kind === 'api_key'
    ? 'get_parent_credit_rollup_as_api_key'
    : 'get_parent_credit_rollup';

  const { data, error } = await callRpc<CreditRollupRpcResult>(db, rpcName, {
    p_parent_org_id: caller.orgId,
    ...callerRpcArg(caller),
  });

  if (error) {
    logger.error({ err: error.message, orgId: caller.orgId }, 'suborg_credit_rollup_rpc_failure');
    return { status: 503, body: { error: 'credit_rollup_unavailable' } };
  }

  if (!data || data.error) {
    const code = data?.error ?? 'unknown_error';
    return { status: CREDIT_RPC_STATUS[code] ?? RPC_UNEXPECTED_STATUS, body: { error: code } };
  }

  return { status: 200, rollup: data };
}

/**
 * Offboarding, shared by both mounts (R9).
 *
 * ORDER IS THE DESIGN: reclaim, then suspend. If the suspend fails after a
 * successful reclaim the credits are safely back with the parent and the
 * sub-org is merely still active, so a retry finishes the job. Suspending first
 * would strand the parent's credits inside an org nobody can act in.
 */
export async function offboardSubOrgCore(
  caller: SubOrgCaller,
  childOrgId: string,
  reason: string | null,
): Promise<SubOrgCoreResponse> {
  // What is left to return? Read before moving anything: a balance we cannot
  // read is a reclaim we cannot size, and guessing would either strand
  // credits or attempt an over-reclaim the RPC would refuse anyway.
  const { data: credits, error: creditsError } = await db
    .from('org_credits')
    .select('balance')
    .eq('org_id', childOrgId)
    .maybeSingle();

  if (creditsError) {
    logger.error({ err: creditsError.message, childOrgId }, 'suborg_offboard_balance_read_failed');
    return { status: 503, body: { error: 'balance_lookup_unavailable' } };
  }

  const balance: number = credits?.balance ?? 0;
  let reclaimed = 0;

  if (balance > 0) {
    const { data: reclaimData, error: reclaimError } = await callRpc<AllocateCreditsRpcResult>(
      db,
      creditRpcName(caller),
      {
        p_parent_org_id: caller.orgId,
        p_child_org_id: childOrgId,
        p_amount: -balance,
        p_note: reason ? `offboarding: ${reason}` : 'offboarding',
        ...callerRpcArg(caller),
      },
    );

    if (reclaimError) {
      logger.error({ err: reclaimError.message, childOrgId }, 'suborg_offboard_reclaim_rpc_failure');
      return { status: 503, body: { error: 'credit_allocation_unavailable' } };
    }
    if (!reclaimData || reclaimData.error) {
      // Stop here. Suspending an org whose credits we failed to reclaim
      // strands them somewhere nobody can spend or recover them.
      const code = reclaimData?.error ?? 'unknown_error';
      return {
        status: CREDIT_RPC_STATUS[code] ?? RPC_UNEXPECTED_STATUS,
        body: { error: code, reclaimed: 0, suspended: false },
      };
    }
    reclaimed = balance;
  }

  const suspendRpc = caller.kind === 'api_key' ? 'suspend_suborg_as_api_key' : 'suspend_suborg';
  const { data: suspendData, error: suspendError } = await callRpc<SuspendRpcResult>(db, suspendRpc, {
    p_parent_org_id: caller.orgId,
    p_sub_org_id: childOrgId,
    p_reason: reason,
    ...callerRpcArg(caller),
  });

  if (suspendError) {
    logger.error({ err: suspendError.message, childOrgId, reclaimed }, 'suborg_offboard_suspend_rpc_failure');
    return { status: 503, body: { error: 'suspend_unavailable', reclaimed, suspended: false } };
  }
  if (!suspendData || suspendData.success !== true) {
    // The reclaim already happened. Say so — a retry is safe, but only if the
    // caller knows not to expect the credits to move a second time.
    const code = suspendData?.error ?? 'unknown_error';
    logger.warn({ childOrgId, reclaimed, code }, 'suborg_offboard_partial');
    return {
      status: SUSPEND_RPC_STATUS[code] ?? RPC_UNEXPECTED_STATUS,
      body: { error: code, reclaimed, suspended: false },
    };
  }

  logger.info({ orgId: caller.orgId, childOrgId, reclaimed, actorKind: caller.kind }, 'suborg_offboarded');
  return {
    status: 200,
    body: {
      reclaimed,
      suspended: true,
      alreadySuspended: suspendData.already_suspended === true,
    },
  };
}

orgSubOrgsRouter.post('/credits', async (req: Request, res: Response) => {
  try {
    const ctx = await requireParentAdmin(req, res);
    if (!ctx) return;

    const parsed = AllocateCreditsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({
        error: 'invalid_request',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const { childOrgId, amount, note } = parsed.data;
    const result = await allocateSubOrgCreditsCore(
      { kind: 'user', userId: ctx.userId, orgId: ctx.orgId },
      childOrgId,
      amount,
      note ?? null,
    );
    res.status(result.status).json(result.body);
  } catch (error) {
    logger.error({ error }, 'Failed to allocate sub-org credits');
    res.status(500).json({ error: 'Internal server error' });
  }
});

orgSubOrgsRouter.get('/credits', async (req: Request, res: Response) => {
  try {
    const ctx = await requireParentAdmin(req, res);
    if (!ctx) return;

    const result = await subOrgCreditRollupCore({ kind: 'user', userId: ctx.userId, orgId: ctx.orgId });
    if (!result.rollup) {
      res.status(result.status).json(result.body ?? { error: 'unknown_error' });
      return;
    }

    // Balances only. Per decision D2 a parent sees what its sub-orgs SPEND,
    // never what they secured — no record contents cross the boundary.
    res.json({
      parentBalance: result.rollup.parent_balance,
      children: (result.rollup.children ?? []).map(
        (c) => ({
          childOrgId: c.child_org_id,
          balance: c.balance,
          monthlyAllocation: c.monthly_allocation,
        }),
      ),
    });
  } catch (error) {
    logger.error({ error }, 'Failed to load sub-org credit rollup');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Sub-org offboarding (SCRUM-3868) ────────────────────────────────────────
//
// Pre-mortem F6: "Revoke" flipped `parent_approval_status` and nothing else —
// the ex-client kept its records, its remaining credits, its members and its
// integrations, and carried on anchoring against a budget the parent funded.
// `parent_approval_status = 'REVOKED'` is enforced in exactly one place
// (cross-org queue resolution), so revocation severs the affiliation, not the
// tenancy. This endpoint is the real lever.
//
// ORDER IS THE DESIGN: reclaim, then suspend. If the suspend fails after a
// successful reclaim the credits are safely back with the parent and the
// sub-org is merely still active, so a retry finishes the job. Suspending first
// would strand the parent's credits inside an org nobody can act in.
//
// The sub-org's ANCHORED RECORDS ARE NOT TOUCHED. They are the customer's
// evidence, not ours, and they must stay verifiable on the public surface after
// the relationship ends.

const OffboardSchema = z.object({
  childOrgId: z.string().uuid(),
  reason: z.string().trim().max(500).optional(),
});

interface SuspendRpcResult {
  success?: boolean;
  already_suspended?: boolean;
  error?: string;
}

orgSubOrgsRouter.post('/offboard', async (req: Request, res: Response) => {
  try {
    const ctx = await requireParentAdmin(req, res);
    if (!ctx) return;

    const parsed = OffboardSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({
        error: 'invalid_request',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }
    const { childOrgId, reason } = parsed.data;

    const result = await offboardSubOrgCore(
      { kind: 'user', userId: ctx.userId, orgId: ctx.orgId },
      childOrgId,
      reason ?? null,
    );
    res.status(result.status).json(result.body);
  } catch (error) {
    logger.error({ error }, 'Failed to offboard sub-org');
    res.status(500).json({ error: 'Internal server error' });
  }
});
