/**
 * DRIVE-01 (SCRUM-2366) — verified-only Google Drive connect eligibility gate.
 *
 * The connector OAuth path (oauth/start + oauth/callback) must DENY unverified
 * and free accounts before any Drive grant is issued or persisted. There is
 * exactly ONE entitlement path:
 *
 *   - ORG admin (or sub-org admin) of a VERIFIED, non-suspended organization.
 *
 * FD-D1 (CTO ruling 2026-08-12): the personal/individual path was REMOVED. It
 * admitted a paid, identity-verified solo user at the gate, and the callback
 * then refused that exact case because `org_integrations.org_id` is NOT NULL —
 * so the user granted Google access to their Drive and silently got nothing.
 * The ruling is to drop the scope, not to build personal-connect storage. The
 * denial now happens BEFORE the OAuth round-trip, so no Drive grant is ever
 * issued for a scope that cannot be persisted, and the reason is specific
 * enough that the user learns why.
 *
 * Every org-membership / admin decision routes through the canonical
 * owner-inclusive resolver in `api/_org-auth.ts` (`getCallerOrgIdResult` /
 * `isCallerOrgAdminResult`) — NEVER re-resolving org from `org_members` alone,
 * which is the #1325/#1326 owner-resolution-drift class (owners are linked via
 * `profiles.org_id`, not guaranteed an `org_members` row).
 *
 * The gate is re-evaluated at BOTH start and callback, so a caller holding a
 * still-valid `state` token whose entitlement lapsed between the two legs is
 * denied at persist time — existing tokens cannot bypass.
 *
 * FAIL CLOSED: a DB/operational error collapses to `lookup_failed` (a denial
 * distinct from a true entitlement failure, so the UI can offer a retry rather
 * than a "get verified" dead-end).
 */
import {
  getCallerOrgIdResult,
  isCallerOrgAdminResult,
} from '../../api/_org-auth.js';

export interface DriveEligibilityDb {
  /** Load the org's verification gate columns. `error:true` on DB failure. */
  getOrganization(orgId: string): Promise<{
    row: { verification_status?: string; suspended?: boolean | null } | null;
    error: boolean;
  }>;
  /**
   * Load the caller's individual-entitlement signals. `error:true` on DB failure.
   *
   * FD-D1: NO LONGER CONSULTED by this module — individual scope is not
   * admitted at all, so plan tier and identity-verification state cannot change
   * the outcome. Retained on the interface (and still supplied by
   * `makeEligibilityDb`) because the callback leg's audit/observability wiring
   * and future org-scoped entitlement checks read from the same injected shape;
   * a consumer that stubs it is not lying about anything.
   */
  getProfileEntitlement(userId: string): Promise<{
    row: { subscription_tier?: string; identity_verified_at?: string | null } | null;
    error: boolean;
  }>;
}

export type DriveConnectDenyReason =
  | 'not_admin'
  /**
   * The caller belongs to an org but invoked the PERSONAL path (no `org_id`).
   * Distinct from `not_admin` on purpose: this is a wrong-scope call by a user
   * who may well be an org OWNER, not an authorization failure. Collapsing the
   * two — as this module did until FD-D3 — makes an org owner read as "not
   * admin", which is both wrong and undiagnosable from the response.
   */
  | 'org_scope_required'
  /**
   * FD-D1: the caller has NO organization at all, and individual (personal
   * Drive) scope is not supported. Distinct from `org_scope_required`, which is
   * an actionable "retry with your org_id" — this caller has no org_id to
   * resend, so telling them to resend one would be a dead end.
   *
   * Replaces `needs_paid_plan` / `individual_not_verified`, both of which
   * implied that upgrading a plan or completing identity verification would
   * open this path. Neither ever could: the OAuth callback persists into
   * `org_integrations.org_id`, which is NOT NULL.
   */
  | 'individual_scope_unsupported'
  | 'org_unverified'
  | 'org_suspended'
  | 'lookup_failed';

/**
 * FD-D1: there is exactly ONE allowed shape — an org-scoped connect. The
 * `{ scope: 'individual' }` variant is deliberately gone rather than merely
 * unreachable, so re-admitting individual scope without also building the
 * personal-connect storage path is a type error, not a silent regression.
 */
export type DriveConnectEligibility =
  | { allowed: true; scope: 'org'; orgId: string }
  | { allowed: false; reason: DriveConnectDenyReason };

/**
 * Resolve whether `userId` may connect Google Drive.
 *
 * When `orgId` is supplied the ORG path is taken: the caller must be an admin
 * (owner-inclusive) of that org AND the org must be VERIFIED + not suspended.
 * That is the ONLY path that can succeed.
 *
 * When `orgId` is omitted the personal path is taken and ALWAYS denies (FD-D1),
 * with one of two distinct reasons: `org_scope_required` if the caller does have
 * an org (retry naming it), `individual_scope_unsupported` if they do not.
 */
export async function resolveDriveConnectEligibility(args: {
  userId: string;
  orgId?: string | null;
  db: DriveEligibilityDb;
}): Promise<DriveConnectEligibility> {
  const { userId, orgId, db } = args;

  // NOTE: this module stays logger-free ON PURPOSE — importing the logger pulls
  // in `config.ts`, whose Zod boot validation would make every consumer's unit
  // test require a full env fixture. Denials are logged by the OAuth route
  // (`logConnectDenial` in api/v1/integrations/drive-oauth.ts), which owns both
  // the start and callback legs and already has the logger + request context.
  if (orgId) {
    return resolveOrgPath(userId, orgId, db);
  }
  return resolveIndividualPath(userId, db);
}

async function resolveOrgPath(
  userId: string,
  orgId: string,
  db: DriveEligibilityDb,
): Promise<DriveConnectEligibility> {
  // Canonical owner-inclusive admin check (owner via profiles.org_id, admin via
  // org_members, ORG_ADMIN/platform-admin via profile). Fail closed on error.
  const admin = await isCallerOrgAdminResult(userId, orgId);
  if (admin.error) return { allowed: false, reason: 'lookup_failed' };
  if (!admin.value) return { allowed: false, reason: 'not_admin' };

  const { row, error } = await db.getOrganization(orgId);
  if (error) return { allowed: false, reason: 'lookup_failed' };
  if (!row) return { allowed: false, reason: 'org_unverified' };
  if (row.verification_status !== 'VERIFIED') {
    return { allowed: false, reason: 'org_unverified' };
  }
  // Parity with the UI entitlement gate: a suspended org is barred from
  // connecting a document source even when KYB-VERIFIED. Legacy null/undefined
  // (pre-suspension-column rows) is treated as not-suspended.
  if (row.suspended === true) {
    return { allowed: false, reason: 'org_suspended' };
  }
  return { allowed: true, scope: 'org', orgId };
}

/**
 * The personal (no `org_id`) path. ALWAYS denies — see FD-D1 on the type above.
 *
 * It still runs the org lookup, because WHICH denial the caller gets is the
 * whole point: `org_scope_required` is a retry instruction, and
 * `individual_scope_unsupported` is a statement that this scope does not exist.
 * Handing the second user the first message sends them to look for an `org_id`
 * they do not have.
 *
 * Note what is NOT here any more: the plan-tier and identity-verification
 * checks. Their denials (`needs_paid_plan`, `individual_not_verified`) told a
 * solo user that paying or verifying would unlock personal connect. It never
 * could — `org_integrations.org_id` is NOT NULL, so the callback rejected the
 * case the gate had just admitted. Keeping those reasons would keep the false
 * promise alive one layer down.
 */
async function resolveIndividualPath(
  userId: string,
  db: DriveEligibilityDb,
): Promise<DriveConnectEligibility> {
  void db; // FD-D1: no entitlement lookup — nothing about this caller can allow it.

  // Routed through the canonical resolver (owner-inclusive), so an owner linked
  // only via profiles.org_id is NOT mis-bucketed as having no org — that owner
  // gets the actionable `org_scope_required`, not the dead-end reason.
  const orgResult = await getCallerOrgIdResult(userId);
  if (orgResult.error) return { allowed: false, reason: 'lookup_failed' };
  if (orgResult.value) {
    // Caller actually belongs to an org but called the personal path without an
    // org id — deny; they must retry the ORG connect path, supplying `org_id`.
    //
    // FD-D3: this used to return `not_admin`, which is what an org OWNER saw
    // when the client omitted `org_id`. The caller's admin status was never
    // even checked here, so reporting "not admin" was not merely confusing, it
    // was unfounded. `org_scope_required` says the actionable thing instead.
    return { allowed: false, reason: 'org_scope_required' };
  }

  return { allowed: false, reason: 'individual_scope_unsupported' };
}

/**
 * Convenience assertion for the OAuth handlers: throws `DriveConnectDenied` when
 * the gate denies, so start/callback can `try/catch` and map `.reason` to the
 * copy.ts entitlement message. Callers that prefer a discriminated result use
 * `resolveDriveConnectEligibility` directly.
 */
export class DriveConnectDenied extends Error {
  readonly reason: DriveConnectDenyReason;
  constructor(reason: DriveConnectDenyReason) {
    super(`drive connect denied: ${reason}`);
    this.name = 'DriveConnectDenied';
    this.reason = reason;
  }
}

export async function assertDriveConnectAllowed(args: {
  userId: string;
  orgId?: string | null;
  db: DriveEligibilityDb;
}): Promise<Extract<DriveConnectEligibility, { allowed: true }>> {
  const result = await resolveDriveConnectEligibility(args);
  if (!result.allowed) {
    throw new DriveConnectDenied(result.reason);
  }
  return result;
}
