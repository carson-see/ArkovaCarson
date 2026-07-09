/**
 * DRIVE-01 (SCRUM-2366) — verified-only Google Drive connect eligibility gate.
 *
 * The connector OAuth path (oauth/start + oauth/callback) must DENY unverified
 * and free accounts before any Drive grant is issued or persisted. There are
 * three distinct entitlement paths:
 *
 *   - ORG admin (or sub-org admin) of a VERIFIED, non-suspended organization.
 *   - Paid + identity-verified INDIVIDUAL connecting a personal Drive.
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

/**
 * Paid subscription tiers that satisfy the individual-connect entitlement.
 * `free` / `org_free` are explicitly excluded. Mirrors the shipped
 * `profiles.subscription_tier` CHECK domain.
 */
const PAID_INDIVIDUAL_TIERS = new Set<string>([
  'starter',
  'professional',
  'enterprise',
  'individual',
  'verified_individual',
  'organization',
  'small_business',
  'medium_business',
]);

export interface DriveEligibilityDb {
  /** Load the org's verification gate columns. `error:true` on DB failure. */
  getOrganization(orgId: string): Promise<{
    row: { verification_status?: string; suspended?: boolean | null } | null;
    error: boolean;
  }>;
  /** Load the caller's individual-entitlement signals. `error:true` on DB failure. */
  getProfileEntitlement(userId: string): Promise<{
    row: { subscription_tier?: string; identity_verified_at?: string | null } | null;
    error: boolean;
  }>;
}

export type DriveConnectDenyReason =
  | 'not_admin'
  | 'org_unverified'
  | 'org_suspended'
  | 'needs_paid_plan'
  | 'individual_not_verified'
  | 'lookup_failed';

export type DriveConnectEligibility =
  | { allowed: true; scope: 'org'; orgId: string }
  | { allowed: true; scope: 'individual'; orgId: null }
  | { allowed: false; reason: DriveConnectDenyReason };

/**
 * Resolve whether `userId` may connect Google Drive.
 *
 * When `orgId` is supplied the ORG path is taken: the caller must be an admin
 * (owner-inclusive) of that org AND the org must be VERIFIED + not suspended.
 * When `orgId` is omitted the INDIVIDUAL path is taken: the caller must be on a
 * paid plan AND identity-verified.
 */
export async function resolveDriveConnectEligibility(args: {
  userId: string;
  orgId?: string | null;
  db: DriveEligibilityDb;
}): Promise<DriveConnectEligibility> {
  const { userId, orgId, db } = args;

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

async function resolveIndividualPath(
  userId: string,
  db: DriveEligibilityDb,
): Promise<DriveConnectEligibility> {
  // Confirm the caller genuinely has NO org before treating them as an
  // individual — routed through the canonical resolver (owner-inclusive), so an
  // owner linked only via profiles.org_id is NOT mis-bucketed as an individual.
  const orgResult = await getCallerOrgIdResult(userId);
  if (orgResult.error) return { allowed: false, reason: 'lookup_failed' };
  if (orgResult.value) {
    // Caller actually belongs to an org but called the personal path without an
    // org id — deny; they must use the org connect path (needs admin).
    return { allowed: false, reason: 'not_admin' };
  }

  const { row, error } = await db.getProfileEntitlement(userId);
  if (error) return { allowed: false, reason: 'lookup_failed' };
  if (!row || !row.subscription_tier || !PAID_INDIVIDUAL_TIERS.has(row.subscription_tier)) {
    return { allowed: false, reason: 'needs_paid_plan' };
  }
  if (!row.identity_verified_at) {
    return { allowed: false, reason: 'individual_not_verified' };
  }
  return { allowed: true, scope: 'individual', orgId: null };
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
