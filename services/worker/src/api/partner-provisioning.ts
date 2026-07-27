/**
 * Partner-account provisioning state machine (SCRUM-2990).
 *
 * The provisioning sprint (3.8) was dropped without Jira IDs; this is the
 * minimal, honest skeleton: request -> approve -> provision (or reject), with
 * org-scoped RBAC, separation of duties, and an audit event per transition.
 * The Aug-9 HakiChain demo org is created THROUGH this flow — not hand-rolled.
 *
 * Explicitly OUT OF SCOPE (no scope creep): SCIM, SAML, directory sync, any
 * identity-federation surface. This is account lifecycle only.
 *
 * Pure + injection-based: no DB, no clock (`at` is passed in). The API layer
 * persists the returned record + audit event (via the existing service_role
 * audit_events writer); this module owns the LEGALITY of every transition so
 * the rules are unit-testable in isolation. Migrations for the backing table
 * are deferred (migrations/ is frozen this window); the record shape here is
 * the contract the future table + API route bind to.
 *
 * Constitution §1.4 (RBAC), §1.5 (audit states what happened, not asserted).
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AuditEventBody } from './audit-event.js';

/** auditEventBodySchema caps details at 10_000 chars; mirror it at the boundary. */
const MAX_DETAILS_LEN = 10_000;

/** Roles recognised for provisioning authorization (org-scoped). */
export type ProvisioningRole = 'platform_admin' | 'owner' | 'org_admin' | 'member';

/**
 * The actor performing a transition.
 *
 * SECURITY CONTRACT (review P1): this MUST be constructed from a SERVER-VERIFIED
 * principal — `userId` from the authenticated JWT `sub`, `orgId`/`role` from an
 * AUTHORITATIVE server-side lookup (org membership + role). It must NEVER be
 * built from request-body/query data. In particular `role: 'platform_admin'`
 * must be derived from an authoritative platform-admin check (e.g.
 * `isPlatformAdmin(verifiedEmail)`), not trusted from a client-supplied string —
 * otherwise a caller could spoof platform_admin and bypass every org gate. The
 * route/adapter that builds this object owns that guarantee; `validateActor`
 * below only checks SHAPE (a defense-in-depth backstop, not the trust boundary).
 */
export interface ProvisioningActor {
  userId: string;
  /** The org the actor is acting within (server-derived). */
  orgId: string;
  role: ProvisioningRole;
}

const provisioningActorSchema = z.object({
  userId: z.string().trim().min(1),
  orgId: z.string().trim().uuid(),
  role: z.enum(['platform_admin', 'owner', 'org_admin', 'member']),
});

/** Shape backstop — the real trust guarantee is the server-derived construction (see contract above). */
function validateActor(actor: ProvisioningActor): void {
  const r = provisioningActorSchema.safeParse(actor);
  if (!r.success) {
    throw new PartnerProvisioningError(
      `invalid actor: ${r.error.issues.map((i) => i.message).join('; ')}`,
      'invalid_input',
    );
  }
}

/** Separation of duties: the requester may not review (approve/reject) their own request. */
function assertNotSelfReview(
  actor: ProvisioningActor,
  record: PartnerAccountRecord,
  verb: 'approve' | 'reject',
): void {
  if (actor.userId === record.requestedBy) {
    throw new PartnerProvisioningError(
      `separation of duties: the requester may not ${verb} their own request`,
      'separation_of_duties',
    );
  }
}

export type PartnerProvisioningStatus =
  | 'requested'
  | 'approved'
  | 'provisioned'
  | 'rejected';

export interface PartnerAccountRecord {
  /**
   * Stable UUID minted at request time. Used as the audit `target_id` for the
   * WHOLE lifecycle so one account is traceable through audit_events by a single
   * key (partnerName is mutable/non-unique; partnerOrgId only exists post-
   * provision). Mirrors the future `partner_accounts.id` (gen_random_uuid()).
   */
  id: string;
  status: PartnerProvisioningStatus;
  partnerName: string;
  partnerContactEmail: string;
  /** The Arkova org sponsoring this partner (RBAC scope for approval). */
  sponsorOrgId: string;
  requestedBy: string;
  requestedAt: string;
  approvedBy?: string;
  approvedAt?: string;
  rejectedBy?: string;
  rejectedAt?: string;
  rejectionReason?: string;
  /** The minted partner org id, set only at provisioning. */
  partnerOrgId?: string;
  provisionedBy?: string;
  provisionedAt?: string;
}

export interface PartnerRequestInput {
  partnerName: string;
  partnerContactEmail: string;
  sponsorOrgId: string;
}

export class PartnerProvisioningError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_input'
      | 'rbac_denied'
      | 'separation_of_duties'
      | 'illegal_transition',
  ) {
    super(message);
    this.name = 'PartnerProvisioningError';
  }
}

export interface TransitionResult {
  record: PartnerAccountRecord;
  audit: AuditEventBody;
}

const requestInputSchema = z.object({
  partnerName: z.string().trim().min(1).max(200),
  partnerContactEmail: z.string().trim().email().max(320),
  // MUST be a UUID: it becomes the audit `org_id`, which auditEventBodySchema
  // enforces as a UUID on write, and the future `partner_accounts.sponsor_org_id`
  // FK -> organizations(id). A non-UUID here would pass this module but fail at
  // the audit insert / FK. (DBA review, SCRUM-2990.)
  sponsorOrgId: z.string().trim().uuid(),
});

/** An actor who may approve/reject/provision for a given sponsor org. */
function assertApprovalAuthority(actor: ProvisioningActor, sponsorOrgId: string): void {
  validateActor(actor);
  if (actor.role === 'platform_admin') return;
  const scoped = actor.orgId === sponsorOrgId;
  const privileged = actor.role === 'owner' || actor.role === 'org_admin';
  if (!scoped || !privileged) {
    throw new PartnerProvisioningError(
      'actor not authorized to act on this partner request (RBAC: needs platform_admin, or owner/admin of the sponsor org)',
      'rbac_denied',
    );
  }
}

/** Bound a details string to the audit schema cap (never throw — truncate). */
function boundDetails(details?: string): string | null {
  if (details == null) return null;
  return details.length > MAX_DETAILS_LEN ? details.slice(0, MAX_DETAILS_LEN) : details;
}

function audit(
  event_type: string,
  record: PartnerAccountRecord,
  details?: string,
): AuditEventBody {
  return {
    event_type,
    event_category: 'ORG',
    target_type: 'partner_account',
    // Stable UUID for the whole lifecycle (≤120-char audit cap; traceable key).
    target_id: record.id,
    // sponsorOrgId is UUID-validated at request time, so this satisfies the
    // audit schema's UUID org_id constraint.
    org_id: record.sponsorOrgId,
    details: boundDetails(details),
  };
}

export function requestPartnerAccount(
  input: PartnerRequestInput,
  actor: ProvisioningActor,
  at: string,
): TransitionResult {
  const parsed = requestInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new PartnerProvisioningError(
      `invalid partner request: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      'invalid_input',
    );
  }
  validateActor(actor);
  // Request-time RBAC: only a platform admin or a member acting within the
  // sponsor org may file a request naming that org — otherwise any user could
  // spam cross-org requests attributed to an arbitrary sponsor. (Architect review.)
  if (actor.role !== 'platform_admin' && actor.orgId !== parsed.data.sponsorOrgId) {
    throw new PartnerProvisioningError(
      'actor not authorized to request a partner account for this sponsor org (RBAC: needs platform_admin or membership of the sponsor org)',
      'rbac_denied',
    );
  }

  const record: PartnerAccountRecord = {
    id: randomUUID(),
    status: 'requested',
    partnerName: parsed.data.partnerName,
    partnerContactEmail: parsed.data.partnerContactEmail,
    sponsorOrgId: parsed.data.sponsorOrgId,
    requestedBy: actor.userId,
    requestedAt: at,
  };
  return { record, audit: audit('partner.account.requested', record) };
}

export function approvePartnerRequest(
  record: PartnerAccountRecord,
  actor: ProvisioningActor,
  at: string,
): TransitionResult {
  if (record.status !== 'requested') {
    throw new PartnerProvisioningError(
      `illegal transition: cannot approve a request in status '${record.status}'`,
      'illegal_transition',
    );
  }
  assertNotSelfReview(actor, record, 'approve');
  assertApprovalAuthority(actor, record.sponsorOrgId);

  const next: PartnerAccountRecord = {
    ...record,
    status: 'approved',
    approvedBy: actor.userId,
    approvedAt: at,
  };
  return { record: next, audit: audit('partner.account.approved', next) };
}

export function rejectPartnerRequest(
  record: PartnerAccountRecord,
  actor: ProvisioningActor,
  reason: string,
  at: string,
): TransitionResult {
  if (record.status !== 'requested') {
    throw new PartnerProvisioningError(
      `illegal transition: cannot reject a request in status '${record.status}'`,
      'illegal_transition',
    );
  }
  assertNotSelfReview(actor, record, 'reject');
  assertApprovalAuthority(actor, record.sponsorOrgId);

  const next: PartnerAccountRecord = {
    ...record,
    status: 'rejected',
    rejectedBy: actor.userId,
    rejectedAt: at,
    rejectionReason: boundDetails(reason) ?? undefined,
  };
  return {
    record: next,
    audit: audit('partner.account.rejected', next, reason),
  };
}

/**
 * Cancel an already-APPROVED request that never got provisioned (partner backed
 * out, or provisioning failed). Without this the record is stuck in 'approved'
 * with no exit. Stays within the 4-state enum by moving approved -> rejected.
 * (Architect review — missing lifecycle leg.) Requires approval authority; the
 * approver may cancel their own approval (unblocking a stuck record is not a
 * separation-of-duties concern).
 */
export function cancelApprovedRequest(
  record: PartnerAccountRecord,
  actor: ProvisioningActor,
  reason: string,
  at: string,
): TransitionResult {
  if (record.status !== 'approved') {
    throw new PartnerProvisioningError(
      `illegal transition: cancelApproved requires status 'approved' (got '${record.status}')`,
      'illegal_transition',
    );
  }
  assertApprovalAuthority(actor, record.sponsorOrgId);

  const next: PartnerAccountRecord = {
    ...record,
    status: 'rejected',
    rejectedBy: actor.userId,
    rejectedAt: at,
    rejectionReason: boundDetails(`cancelled after approval: ${reason}`) ?? undefined,
  };
  return {
    record: next,
    audit: audit('partner.account.cancelled', next, reason),
  };
}

export interface ProvisionInput {
  /** The minted partner org id (created by the org-creation path, injected). */
  partnerOrgId: string;
}

export function provisionPartnerAccount(
  record: PartnerAccountRecord,
  actor: ProvisioningActor,
  input: ProvisionInput,
  at: string,
): TransitionResult {
  if (record.status !== 'approved') {
    throw new PartnerProvisioningError(
      `illegal transition: cannot provision a request that is not approved (status '${record.status}')`,
      'illegal_transition',
    );
  }
  assertApprovalAuthority(actor, record.sponsorOrgId);

  // partnerOrgId is the minted organization id → must be a UUID (same boundary
  // as sponsorOrgId; future partner_org_id FK -> organizations(id)). Validating
  // it here stops an invalid id from being accepted by the state machine and
  // only failing later at persistence, after the transition was logically
  // accepted. (Review P1.)
  const partnerOrgId = input.partnerOrgId?.trim();
  if (!partnerOrgId || !z.string().uuid().safeParse(partnerOrgId).success) {
    throw new PartnerProvisioningError(
      'partnerOrgId is required and must be a UUID to provision',
      'invalid_input',
    );
  }

  const next: PartnerAccountRecord = {
    ...record,
    status: 'provisioned',
    partnerOrgId,
    provisionedBy: actor.userId,
    provisionedAt: at,
  };
  return {
    // target_id stays the stable record id; the minted partner org id is
    // captured in details (traceable lifecycle key, per DBA/Architect review).
    record: next,
    audit: audit('partner.account.provisioned', next, `partnerOrgId=${partnerOrgId}`),
  };
}
