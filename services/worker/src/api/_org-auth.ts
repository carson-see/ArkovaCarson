/**
 * Shared org-auth helpers for service_role API handlers.
 *
 * The worker uses a service_role Supabase client which bypasses RLS — every
 * cross-tenant write must explicitly scope by `org_id = caller's org`. These
 * helpers are the single source of truth for that lookup so handlers don't
 * each re-implement (and drift on) the auth fallback rules.
 *
 * Two flavours of each lookup:
 *   - The plain `boolean` / `string | null` helpers (`getCallerOrgId`,
 *     `isCallerOrgAdmin`, `isUserMemberOfOrg`) FAIL CLOSED: a DB/operational
 *     error collapses to "not authorized" (falsy). Most handlers want this —
 *     a transient lookup failure should never grant access.
 *   - The `*Result` variants additionally surface whether the lookup hit a
 *     DB/operational `error`, so a handler that needs to distinguish a *true*
 *     negative (→ 403) from an *operational* failure (→ 500) can do so without
 *     masking the fault as a 403. (Mirrors the own-user CPE export endpoint,
 *     which inspects the Supabase `error` and maps it to 500 — PR #1029.)
 *
 * The boolean helpers delegate to the `*Result` variants and drop the error
 * flag, so there is a single query/precedence implementation per lookup.
 */
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

interface CallerProfile {
  org_id: string | null;
  role: string | null;
  is_platform_admin: boolean | null;
}

/**
 * A lookup outcome plus whether the lookup hit a DB/operational error.
 * `error: true` means "could not determine" (treat as 500-worthy); the value
 * field is still fail-closed (falsy) so callers that ignore `error` stay safe.
 */
interface OrgAuthResult<T> {
  value: T;
  /** True when a Supabase/DB error prevented a definitive answer. */
  error: boolean;
}

/**
 * Internal: single profile fetch covering the columns every callsite needs
 * (org id, role, platform-admin flag), surfacing whether the lookup errored.
 * A missing profile is `{ profile: null, error: false }` (true negative); a DB
 * failure is `{ profile: null, error: true }` (operational).
 */
async function loadCallerProfile(
  userId: string,
): Promise<{ profile: CallerProfile | null; error: boolean }> {
  const { data, error } = await db
    .from('profiles')
    .select('org_id, role, is_platform_admin')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    logger.warn({ error, userId }, 'org-auth: profile lookup failed');
    return { profile: null, error: true };
  }
  return { profile: (data as CallerProfile | null) ?? null, error: false };
}

/**
 * Single profile fetch covering the columns every callsite needs (org id,
 * role, platform-admin flag). Returns null if profile is missing or the
 * lookup errors — callers MUST treat null as fail-closed (403) to avoid
 * leaking the no-org case as success.
 */
export async function getCallerProfile(userId: string): Promise<CallerProfile | null> {
  const { profile } = await loadCallerProfile(userId);
  return profile;
}

/**
 * Resolve the caller's org id, surfacing whether the profile lookup hit a
 * DB/operational error. `{ orgId: null, error: false }` is a true "no org on
 * profile" (→ 403); `{ orgId: null, error: true }` is an operational failure
 * (→ 500).
 */
export async function getCallerOrgIdResult(userId: string): Promise<OrgAuthResult<string | null>> {
  const { profile, error } = await loadCallerProfile(userId);
  return { value: profile?.org_id ?? null, error };
}

export async function getCallerOrgId(userId: string): Promise<string | null> {
  return (await getCallerOrgIdResult(userId)).value;
}

/**
 * Org-admin check with the same precedence used across the worker:
 *   1. `org_members.role` is owner/admin → admin.
 *   2. Profile role = 'ORG_ADMIN' or `is_platform_admin = true` → admin.
 *
 * Surfaces `error: true` when EITHER underlying lookup (the `org_members` row
 * or the profile fallback) hit a DB/operational error AND no positive admin
 * signal was found — so a handler can return 500 instead of masking the fault
 * as a 403. A definitive non-admin answer is `{ isAdmin: false, error: false }`.
 *
 * Pass an already-loaded profile to avoid a redundant `profiles` query when
 * the caller has just resolved the org id via `getCallerProfile`.
 */
export async function isCallerOrgAdminResult(
  userId: string,
  orgId: string,
  preloadedProfile?: CallerProfile | null,
): Promise<OrgAuthResult<boolean>> {
  // Capture the `org_members` error explicitly (was previously dropped) so a DB
  // failure here is fail-closed AND observable, not silently swallowed.
  const { data: membership, error: memberError } = await db
    .from('org_members')
    .select('role')
    .eq('user_id', userId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (memberError) {
    logger.warn({ error: memberError, userId, orgId }, 'org-auth: admin membership lookup failed');
  }
  const role = (membership as { role?: string } | null)?.role;
  if (role === 'owner' || role === 'admin') return { value: true, error: false };

  // Profile fallback (role = ORG_ADMIN or platform admin). Reuse a non-null
  // preloaded profile to avoid a redundant round-trip; otherwise fetch (this
  // matches the original `preloadedProfile ?? (await getCallerProfile(...))`
  // semantics, which also re-fetched when an explicit `null` was passed).
  let profile = preloadedProfile ?? null;
  let profileError = false;
  if (preloadedProfile == null) {
    const loaded = await loadCallerProfile(userId);
    profile = loaded.profile;
    profileError = loaded.error;
  }
  // The profile `ORG_ADMIN` role is OWN-ORG scoped — it makes the caller an
  // admin of THEIR org (`profile.org_id`), not of every org. Without the
  // `org_id === orgId` guard a profile-level ORG_ADMIN of org-1 would pass this
  // check for an UNRELATED org-2 (cross-org privilege escalation), since the
  // `org_members` probe above already returned no row for org-2. Platform
  // admins (`is_platform_admin`) ARE global by design, so they stay cross-org.
  const isOrgAdminOfThisOrg = profile?.role === 'ORG_ADMIN' && profile?.org_id === orgId;
  const isAdmin = isOrgAdminOfThisOrg || profile?.is_platform_admin === true;

  // Only report an operational error when we did NOT find a positive signal:
  // an admin answer is definitive regardless of a later lookup hiccup.
  return { value: isAdmin, error: isAdmin ? false : memberError != null || profileError };
}

export async function isCallerOrgAdmin(
  userId: string,
  orgId: string,
  preloadedProfile?: CallerProfile | null,
): Promise<boolean> {
  return (await isCallerOrgAdminResult(userId, orgId, preloadedProfile)).value;
}

/**
 * Membership predicate: is `targetUserId` a member of `orgId`?
 *
 * Used when an org admin acts ON another member (e.g. exporting that member's
 * compliance log). The worker runs as service_role and bypasses RLS, so this
 * is the single source of truth for the "target belongs to my org" gate that
 * prevents cross-org access. Fails closed: any lookup error → not a member.
 *
 * Honors BOTH membership signals the codebase uses, mirroring
 * `isCallerOrgAdmin`'s dual-source precedence:
 *   1. an `org_members` row for (targetUserId, orgId), OR
 *   2. the target's `profiles.org_id` equals `orgId`.
 *
 * Either signal alone is sufficient — a member linked only via `profiles.org_id`
 * (as the R2 own-user export relied on) is still recognized.
 *
 * The `*Result` variant additionally reports whether a DB/operational error
 * blocked a definitive answer (so the caller can 500 instead of 403).
 */
export async function isUserMemberOfOrgResult(
  targetUserId: string,
  orgId: string,
): Promise<OrgAuthResult<boolean>> {
  if (!targetUserId || !orgId) return { value: false, error: false };

  const { data: membership, error: memberError } = await db
    .from('org_members')
    .select('user_id')
    .eq('user_id', targetUserId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (memberError) {
    logger.warn({ error: memberError, targetUserId, orgId }, 'org-auth: membership lookup failed');
  }
  if (membership) return { value: true, error: false };

  // Fallback: profiles.org_id linkage (no org_members row required).
  const { profile, error: profileError } = await loadCallerProfile(targetUserId);
  if (profile?.org_id === orgId) return { value: true, error: false };

  // Definitive non-member only when NEITHER lookup errored; otherwise the
  // negative might be a masked operational failure.
  return { value: false, error: memberError != null || profileError };
}

export async function isUserMemberOfOrg(
  targetUserId: string,
  orgId: string,
): Promise<boolean> {
  return (await isUserMemberOfOrgResult(targetUserId, orgId)).value;
}
