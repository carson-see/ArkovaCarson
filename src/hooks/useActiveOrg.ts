/**
 * Active organization context hook (SCRUM-1651 ORG-HIER-01).
 *
 * Resolves the user's active org_id deterministically per PRD 6 §ORG-02:
 * "Users with multiple memberships select or are routed into a deterministic
 *  active org; APIs do not assume first membership."
 *
 * Resolution order:
 *   1. URL pattern `/orgs/:orgId/...` — explicit, primary path. The URL
 *      survives reload, can be shared, and is the only source that is
 *      actually unambiguous for users who admin both a parent and a sub-org.
 *   2. localStorage stickiness within a session — once a user picks an org
 *      from the multi-org switcher we remember that choice for the duration
 *      of the session, but only as a fallback when the URL lacks /orgs/:id.
 *   3. profile.org_id — the legacy "primary org" column on profiles. We
 *      surface this with a `kind: 'implicit_primary'` discriminator so
 *      callers can branch on whether the choice was explicit (URL/storage)
 *      or implicit (profile fallback). Callers in launch-critical paths
 *      should treat `implicit_primary` as a soft warning if the user has
 *      multiple memberships — the legacy code paths still work, but the
 *      migration target is to require an explicit choice.
 *
 * The hook is intentionally read-only — switching the active org is a route
 * change (push to /orgs/:newId) so the URL stays the source of truth.
 */
import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useProfile } from './useProfile';
import { useUserOrgs } from './useUserOrgs';

const STORAGE_KEY = 'arkova.activeOrg.v1';

export type ActiveOrgKind =
  | { kind: 'url'; orgId: string }
  | { kind: 'session'; orgId: string }
  | { kind: 'implicit_primary'; orgId: string; multiMembership: boolean }
  | { kind: 'none' };

export interface UseActiveOrgResult {
  /** Resolved org id (null when the user has no membership at all). */
  orgId: string | null;
  /** The resolution path. Inspect for telemetry / migration warnings. */
  source: ActiveOrgKind;
  /** True when the user has more than one org membership. */
  hasMultipleMemberships: boolean;
  /** True until both profile + memberships have loaded. */
  loading: boolean;
}

function readSessionOrg(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage?.getItem(STORAGE_KEY);
    return v && /^[0-9a-f-]{36}$/i.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Persist a session-level org selection. Called by the multi-org switcher
 * AFTER navigation to /orgs/:orgId, so the URL is still the source of truth
 * but a tab without /orgs/:id in the path can fall back to the user's last
 * picked org instead of silently jumping to profile.org_id.
 */
export function rememberActiveOrg(orgId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage?.setItem(STORAGE_KEY, orgId);
  } catch {
    /* noop — incognito or storage disabled */
  }
}

export function clearRememberedActiveOrg(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
}

/**
 * Pure resolver. Exported for testing without spinning up the React Query
 * client. The hook below adapts its inputs from useProfile / useUserOrgs.
 */
export function resolveActiveOrg(args: {
  urlOrgId: string | null | undefined;
  sessionOrgId: string | null;
  profileOrgId: string | null | undefined;
  membershipOrgIds: string[];
}): { orgId: string | null; source: ActiveOrgKind; hasMultipleMemberships: boolean } {
  const memberSet = new Set(args.membershipOrgIds);
  const hasMulti = args.membershipOrgIds.length > 1;

  // 1. URL — only honored if it appears in the user's memberships. An
  //    attacker who pastes /orgs/<other-tenant-id> in the URL bar must
  //    not gain anything; downstream Supabase RLS will block reads
  //    anyway, but resolving here means the active org chrome doesn't
  //    falsely indicate they're "in" that org.
  if (args.urlOrgId && memberSet.has(args.urlOrgId)) {
    return {
      orgId: args.urlOrgId,
      source: { kind: 'url', orgId: args.urlOrgId },
      hasMultipleMemberships: hasMulti,
    };
  }

  // 2. Session storage — same membership check as URL.
  if (args.sessionOrgId && memberSet.has(args.sessionOrgId)) {
    return {
      orgId: args.sessionOrgId,
      source: { kind: 'session', orgId: args.sessionOrgId },
      hasMultipleMemberships: hasMulti,
    };
  }

  // 3. Implicit primary fallback. Only honored if the user actually has
  //    a membership row for it (legacy profiles.org_id can drift if a
  //    membership was revoked).
  if (args.profileOrgId && memberSet.has(args.profileOrgId)) {
    return {
      orgId: args.profileOrgId,
      source: { kind: 'implicit_primary', orgId: args.profileOrgId, multiMembership: hasMulti },
      hasMultipleMemberships: hasMulti,
    };
  }

  // 4. No membership at all (individual-tier user) — return null. Pages
  //    that require an active org should render the OrgRequiredCard or
  //    a multi-org picker depending on context.
  return {
    orgId: null,
    source: { kind: 'none' },
    hasMultipleMemberships: hasMulti,
  };
}

export function useActiveOrg(): UseActiveOrgResult {
  const params = useParams<{ orgId?: string }>();
  const { profile, loading: profileLoading } = useProfile();
  const { orgs, loading: orgsLoading } = useUserOrgs();

  return useMemo<UseActiveOrgResult>(() => {
    const sessionOrgId = readSessionOrg();
    const membershipOrgIds = orgs.map((o) => o.orgId);
    const { orgId, source, hasMultipleMemberships } = resolveActiveOrg({
      urlOrgId: params.orgId ?? null,
      sessionOrgId,
      profileOrgId: profile?.org_id ?? null,
      membershipOrgIds,
    });
    return {
      orgId,
      source,
      hasMultipleMemberships,
      loading: profileLoading || orgsLoading,
    };
  }, [params.orgId, profile?.org_id, profileLoading, orgs, orgsLoading]);
}
