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

import { z } from 'zod';
import type { AuditEventBody } from './audit-event.js';

/** Roles recognised for provisioning authorization (org-scoped). */
export type ProvisioningRole = 'platform_admin' | 'owner' | 'org_admin' | 'member';

export interface ProvisioningActor {
  userId: string;
  /** The org the actor is acting within. */
  orgId: string;
  role: ProvisioningRole;
}

export type PartnerProvisioningStatus =
  | 'requested'
  | 'approved'
  | 'provisioned'
  | 'rejected';

export interface PartnerAccountRecord {
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
  sponsorOrgId: z.string().trim().min(1),
});

/** An actor who may approve/reject/provision for a given sponsor org. */
function assertApprovalAuthority(actor: ProvisioningActor, sponsorOrgId: string): void {
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

function audit(
  event_type: string,
  record: PartnerAccountRecord,
  targetId?: string | null,
  details?: string,
): AuditEventBody {
  return {
    event_type,
    event_category: 'ORG',
    target_type: 'partner_account',
    target_id: targetId ?? record.partnerName,
    // The event belongs to the sponsoring org. In real usage sponsorOrgId is a
    // UUID; the API-layer auditEventBodySchema enforces the UUID shape on write.
    org_id: record.sponsorOrgId,
    details: details ?? null,
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
  const record: PartnerAccountRecord = {
    status: 'requested',
    partnerName: parsed.data.partnerName,
    partnerContactEmail: parsed.data.partnerContactEmail,
    sponsorOrgId: parsed.data.sponsorOrgId,
    requestedBy: actor.userId,
    requestedAt: at,
  };
  return { record, audit: audit('partner.account.requested', record, record.partnerName) };
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
  if (actor.userId === record.requestedBy) {
    throw new PartnerProvisioningError(
      'separation of duties: the requester may not approve their own request',
      'separation_of_duties',
    );
  }
  assertApprovalAuthority(actor, record.sponsorOrgId);

  const next: PartnerAccountRecord = {
    ...record,
    status: 'approved',
    approvedBy: actor.userId,
    approvedAt: at,
  };
  return { record: next, audit: audit('partner.account.approved', next, next.partnerName) };
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
  if (actor.userId === record.requestedBy) {
    throw new PartnerProvisioningError(
      'separation of duties: the requester may not reject their own request',
      'separation_of_duties',
    );
  }
  assertApprovalAuthority(actor, record.sponsorOrgId);

  const next: PartnerAccountRecord = {
    ...record,
    status: 'rejected',
    rejectedBy: actor.userId,
    rejectedAt: at,
    rejectionReason: reason,
  };
  return {
    record: next,
    audit: audit('partner.account.rejected', next, next.partnerName, reason),
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

  const partnerOrgId = input.partnerOrgId?.trim();
  if (!partnerOrgId) {
    throw new PartnerProvisioningError('partnerOrgId is required to provision', 'invalid_input');
  }

  const next: PartnerAccountRecord = {
    ...record,
    status: 'provisioned',
    partnerOrgId,
    provisionedBy: actor.userId,
    provisionedAt: at,
  };
  return {
    record: next,
    audit: audit('partner.account.provisioned', next, partnerOrgId),
  };
}
