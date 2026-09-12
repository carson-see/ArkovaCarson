/**
 * Who is acting on the sub-organization surface, and on which child (SCRUM-3971).
 *
 * `orgSubOrgs.ts` is mounted twice from 2026-09-12: the original JWT mount at
 * `index.ts:532` (`/api/v1/org/sub-orgs`, `requireAuthMw`) and the API-key
 * mount inside `api/v1/router.ts` (`/organizations/sub-orgs`). The two differ in
 * exactly two places — who the caller is, and how a child is named — so those
 * two live here and everything downstream is shared. Duplicating the authority
 * decision per mount is how the JWT surface and the RPCs drifted apart in the
 * first place (SCRUM-5031).
 *
 * ## The API-key caller acts as its ORGANIZATION
 *
 * `req.apiKey.orgId`, never `req.apiKey.userId`. The latter is the human who
 * minted the key; treating it as the actor would let any key inherit whatever
 * that person can do in any organization they belong to, which is privilege
 * laundering with extra steps. The key's authority is: its own organization,
 * plus the `orgs:manage` scope, re-checked independently inside the
 * `*_as_api_key` RPCs (migration 0453) under `FOR UPDATE`.
 *
 * ## An organization that HAS a parent may not act as one
 *
 * `check_sub_org_depth` (baseline) allows exactly one level, so a child has no
 * children to manage. Refusing here rather than returning an empty list makes
 * the boundary explicit instead of implicit-and-coincidental: if the depth
 * limit were ever raised, an unguarded key surface would silently start
 * exposing grandchildren.
 *
 * ## Both credentials at once is a 409, not a preference
 *
 * A request carrying a verified JWT identity AND an API key does not say which
 * organization it is acting as, and the two can legitimately differ. Picking
 * one lets the weaker credential decide — the defect class
 * `middleware/requireScopeAnyAuth.ts` documents at length. Neither mount can
 * produce that combination today (the key mount runs no `requireAuth`, the JWT
 * mount runs no `apiKeyAuth`), so this is a guard against a future mount, not a
 * live path; it is refused unconditionally rather than only when the two
 * disagree, because establishing agreement needs a second lookup whose failure
 * mode is worse than refusing.
 *
 * ## Child resolution is 404-SHAPING ONLY
 *
 * Nothing here authorizes a write. Authority lives in the `FOR UPDATE` RPCs
 * (0444 / 0450 / 0453) and in the compare-and-set at `orgSubOrgs.ts`'s
 * `updateAffiliateStatus`. These reads exist so the key surface can answer
 * "which child?" and can collapse every negative — absent, another parent's,
 * not approved yet, suspended — into ONE `404 sub_org_not_found`. A 403 on
 * "another parent's child" would confirm that a public id exists and belongs to
 * someone; the key surface must not be an existence oracle. The JWT surface
 * keeps its 403s, which are correct there: that caller already knows the
 * organization exists, having been shown it in the dashboard.
 */
import type { Request } from 'express';
import { db as _db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getAuthenticatedUserId } from '../../middleware/authContext.js';
import { isCallerOrgAdminResult, getCallerProfileResult } from '../_org-auth.js';

// Sub-org columns from migration 0128 are not in the generated types yet.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;
const defaultDb: Db = _db;

export type SubOrgCaller =
  | { kind: 'user'; userId: string; orgId: string }
  | { kind: 'api_key'; apiKeyId: string; keyPrefix: string; orgId: string };

export interface SubOrgFailure {
  ok: false;
  status: number;
  error: string;
  /** Optional human-readable half, preserved verbatim where a route already had one. */
  message?: string;
}

export type SubOrgResult<T> = { ok: true; value: T } | SubOrgFailure;

/** A child organization, resolved. `id` is internal and MUST NOT be serialized. */
export interface SubOrgChild {
  id: string;
  publicId: string;
  displayName: string;
  parentApprovalStatus: string | null;
  suspended: boolean;
}

function fail(status: number, error: string, message?: string): SubOrgFailure {
  return message === undefined ? { ok: false, status, error } : { ok: false, status, error, message };
}

function succeed<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

function isOrgAdminRole(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * Resolve the single organization a JWT caller administers.
 *
 * Explicit `?orgId=` defers to `isCallerOrgAdminResult`, which already carries
 * the full precedence rule (org_members owner/admin, then own-org profile
 * ORG_ADMIN, then platform admin) and separates a DB fault from a definitive
 * "no".
 *
 * Without an explicit org the caller may administer several. The affiliate flow
 * writes the parent admin into every child's `org_members` as `owner`, so a
 * partner admin belongs to the parent AND to each client organization, and
 * whichever row we picked would decide which balance a transfer debits. Refuse
 * rather than guess.
 *
 * **SCRUM-5031.** `org_members` alone is not the whole admin population:
 * migrations 0444 / 0450 also admit an own-organization `profiles.role =
 * 'ORG_ADMIN'`, so a parent administrator carried only by a profile row was
 * 403'd at the route while the RPC would have admitted them. The profile is
 * consulted when `org_members` returns NO row for this user — which is exactly
 * the "profile-only ORG_ADMIN" population the ticket names. It is deliberately
 * NOT consulted when a membership row exists: an explicit `role = 'member'` row
 * is a statement that this user is not an admin there, and unioning anyway
 * would turn a today-unambiguous caller into a 400 without granting anything
 * new. A caller who is BOTH a plain member of one organization and a profile
 * ORG_ADMIN of another still reaches the latter with `?orgId=` — that branch
 * runs the full union — which is the documented way to disambiguate regardless.
 */
export async function resolveParentAdminOrg(
  userId: string,
  requestedOrgId: string | undefined,
  database: Db = defaultDb,
): Promise<SubOrgResult<string>> {
  if (requestedOrgId) {
    // `database`, not the module `db`: this function takes an injected client
    // and honouring it for only one of its three reads is a split brain a test
    // cannot see (review B7). `preloadedProfile` stays undefined so the shared
    // helper does its own profile fetch — through the same injected client.
    const admin = await isCallerOrgAdminResult(userId, requestedOrgId, undefined, database);
    if (admin.error) return fail(503, 'membership_lookup_unavailable');
    if (!admin.value) return fail(403, 'Admin permissions required');
    return succeed(requestedOrgId);
  }

  const { data: memberships, error } = await database
    .from('org_members')
    .select('org_id, role')
    .eq('user_id', userId);

  if (error) {
    // Tag unchanged from `orgSubOrgs.ts`'s pre-extraction version on purpose:
    // it is a string an external alert may already key on, and renaming it
    // while moving the code would silently retire that alert (review B6).
    logger.error({ err: error.message }, 'suborg_credit_membership_lookup_failed');
    return fail(503, 'membership_lookup_unavailable');
  }

  // `?? []` would turn a shape fault into "this caller administers nothing",
  // which is a 403 the operator cannot distinguish from a real refusal. A
  // successful PostgREST list read is an array; anything else is a fault.
  if (!Array.isArray(memberships)) {
    logger.error({ userId }, 'suborg_caller_membership_lookup_shape');
    return fail(503, 'membership_lookup_unavailable');
  }
  const rows = memberships as { org_id: string; role: string | null }[];

  if (rows.length === 0) {
    // SCRUM-5031 — see the header of this function.
    const { value: profile, error: profileError } = await getCallerProfileResult(userId, database);
    if (profileError) {
      logger.error({ userId }, 'suborg_caller_profile_fallback_lookup_failed');
      return fail(503, 'membership_lookup_unavailable');
    }
    if (profile?.role === 'ORG_ADMIN' && profile.org_id) {
      return succeed(profile.org_id);
    }
    return fail(403, 'Admin permissions required');
  }

  const adminOrgs = rows.filter((m) => isOrgAdminRole(m.role));
  if (adminOrgs.length === 0) return fail(403, 'Admin permissions required');
  if (adminOrgs.length > 1) {
    return fail(
      400,
      'org_id_required',
      'You administer more than one organization. Specify which one with ?orgId=.',
    );
  }
  return succeed(adminOrgs[0].org_id);
}

/** Resolve the acting principal for either mount. See this module's header. */
export async function resolveSubOrgCaller(
  req: Request,
  database: Db = defaultDb,
): Promise<SubOrgResult<SubOrgCaller>> {
  const userId = getAuthenticatedUserId(req);
  const apiKey = req.apiKey;

  if (userId && apiKey) {
    logger.error(
      { apiKeyId: apiKey.keyId },
      'suborg_caller_ambiguous — request carried both a verified JWT identity and an API key',
    );
    return fail(
      409,
      'ambiguous_caller',
      'This request presents both a session and an API key. Send exactly one.',
    );
  }

  if (apiKey) {
    const { data: actingOrg, error } = await database
      .from('organizations')
      .select('id, parent_org_id')
      .eq('id', apiKey.orgId)
      .maybeSingle();

    if (error) {
      logger.error({ err: error.message, apiKeyId: apiKey.keyId }, 'suborg_caller_acting_org_lookup_failed');
      return fail(503, 'org_lookup_unavailable');
    }
    if (!actingOrg) {
      logger.error({ apiKeyId: apiKey.keyId }, 'suborg_caller_acting_org_missing');
      return fail(403, 'acting_org_not_found');
    }
    if (actingOrg.parent_org_id !== null && actingOrg.parent_org_id !== undefined) {
      return fail(
        403,
        'sub_org_cannot_manage_sub_orgs',
        'This key belongs to an affiliated organization, which cannot administer affiliates of its own.',
      );
    }

    return succeed({
      kind: 'api_key',
      apiKeyId: apiKey.keyId,
      keyPrefix: apiKey.keyPrefix,
      orgId: apiKey.orgId,
    });
  }

  if (!userId) {
    return fail(401, 'Authentication required');
  }

  const requestedOrgId = typeof req.query?.orgId === 'string' ? req.query.orgId : undefined;
  const org = await resolveParentAdminOrg(userId, requestedOrgId, database);
  if (!org.ok) return org;
  return succeed({ kind: 'user', userId, orgId: org.value });
}

/**
 * ## The affiliation lifecycle, and why each action accepts what it accepts
 *
 * ```
 *            request (JWT, child-side)
 *                    │
 *                    ▼
 *   (null) ───────► PENDING ──approve──► APPROVED ──revoke──► REVOKED
 *                    │                     │                     │
 *                    │                  offboard             offboard
 *                    │                (reclaim+suspend)    (reclaim+suspend)
 *                    │                     │                     │
 *                    ▼                     ▼                     ▼
 *                  revoke            APPROVED+suspended    REVOKED+suspended
 *                    │                     │
 *                    ▼                  revoke
 *                 REVOKED                  │
 *                                          ▼
 *                                  REVOKED+suspended
 *
 *   credits: APPROVED and not suspended, only.
 * ```
 *
 * The first cut of this surface used one predicate for approve and revoke
 * (`APPROVED`-or-not, suspended never addressable) and `requireApproved` for
 * offboard. That made two documented orders UNREACHABLE on the key surface: a
 * parent who offboarded first could never revoke (offboard suspends, and revoke
 * refused suspended children), and a parent who revoked first could never
 * offboard (offboard demanded `APPROVED`), so the reclaimed-credits half of the
 * lifecycle was stranded behind whichever call happened to come first — while
 * the child kept consuming a slot under the affiliate cap, which counts
 * `APPROVED` rows.
 *
 * So the predicate is per ACTION, not per surface:
 *
 *   - **approve** accepts `PENDING` only. Approving is the transition out of
 *     PENDING; every other status is either already the destination or a
 *     deliberate end state, and re-approving a REVOKED affiliation is a new
 *     decision that goes through `request` again.
 *   - **revoke** accepts `APPROVED` or `PENDING` — revoking a pending request
 *     is a real parent action ("no"), and revoking after an offboard is the
 *     documented tail of the wind-down.
 *   - **offboard** accepts ANY owned child, in any status, suspended or not.
 *     It is reclaim-then-suspend and therefore idempotent by construction:
 *     a retry answers `already_suspended: true`, which is a success.
 *   - **credits** accepts `APPROVED` and not suspended. Money does not move
 *     into an affiliation that is not live.
 *
 * Suspension does NOT gate approve or revoke. Suspension is an operational
 * state ("this affiliate cannot act"); the approval status is the relationship.
 * Conflating them is what stranded the lifecycle.
 */
interface ChildPredicate {
  /**
   * Approval statuses this action accepts. `null` accepts EVERY status,
   * including the SQL NULL the column still admits.
   */
  allowedStatuses: readonly string[] | null;
  /** Whether a suspended child is still addressable. */
  allowSuspended: boolean;
  label: string;
}

async function resolveChild(
  caller: SubOrgCaller,
  orgPublicId: string,
  predicate: ChildPredicate,
  database: Db,
): Promise<SubOrgResult<SubOrgChild>> {
  const { data, error } = await database
    .from('organizations')
    .select('id, public_id, display_name, parent_org_id, parent_approval_status, suspended')
    .eq('public_id', orgPublicId)
    .eq('parent_org_id', caller.orgId)
    .maybeSingle();

  if (error) {
    // An outage is not an absence. Collapsing this into the 404 would tell a
    // partner their affiliate had been removed.
    logger.error({ err: error.message, orgId: caller.orgId }, 'suborg_child_lookup_failed');
    return fail(503, 'sub_org_lookup_unavailable');
  }

  const notFound = (reason: string): SubOrgFailure => {
    // info, not error: a client naming an organization it may not address is a
    // determinate answer, not a fault. The reason is logged because the caller
    // only ever sees one undifferentiated 404.
    logger.info({ orgId: caller.orgId, reason, action: predicate.label }, 'suborg_child_not_addressable');
    return fail(404, 'sub_org_not_found');
  };

  if (!data) return notFound('no_such_child_of_caller');
  if (
    predicate.allowedStatuses !== null
    && !predicate.allowedStatuses.includes(data.parent_approval_status ?? '')
  ) {
    return notFound(`approval_status_${data.parent_approval_status ?? 'null'}`);
  }
  if (!predicate.allowSuspended && data.suspended === true) return notFound('suspended');

  return succeed({
    id: data.id,
    publicId: data.public_id,
    displayName: data.display_name,
    parentApprovalStatus: data.parent_approval_status ?? null,
    suspended: data.suspended === true,
  });
}

/**
 * approve. `PENDING` is the only status approving can transition out of.
 * Suspension is irrelevant to the relationship decision, so it does not gate.
 */
export function resolveChildForApprove(
  caller: SubOrgCaller,
  orgPublicId: string,
  database: Db = defaultDb,
): Promise<SubOrgResult<SubOrgChild>> {
  return resolveChild(caller, orgPublicId, { allowedStatuses: ['PENDING'], allowSuspended: true, label: 'approve' }, database);
}

/**
 * revoke. `APPROVED` (end a live affiliation) and `PENDING` (refuse a request)
 * both revoke. Suspended children stay addressable — offboard→revoke is the
 * documented wind-down order and offboard leaves the child suspended.
 */
export function resolveChildForRevoke(
  caller: SubOrgCaller,
  orgPublicId: string,
  database: Db = defaultDb,
): Promise<SubOrgResult<SubOrgChild>> {
  return resolveChild(
    caller,
    orgPublicId,
    { allowedStatuses: ['APPROVED', 'PENDING'], allowSuspended: true, label: 'revoke' },
    database,
  );
}

/** Credit allocation. An affiliation that is not live must not move money. */
export function resolveApprovedChild(
  caller: SubOrgCaller,
  orgPublicId: string,
  database: Db = defaultDb,
): Promise<SubOrgResult<SubOrgChild>> {
  return resolveChild(caller, orgPublicId, { allowedStatuses: ['APPROVED'], allowSuspended: false, label: 'credits' }, database);
}

/**
 * Offboarding. ANY owned child, in any status, suspended or not: offboard is
 * reclaim-then-suspend and a run that reclaimed but failed to suspend must be
 * retryable, and revoke→offboard must work as well as offboard→revoke. The
 * idempotent answer (`already_suspended: true`) is a success, not a refusal.
 */
export function resolveOwnedChild(
  caller: SubOrgCaller,
  orgPublicId: string,
  database: Db = defaultDb,
): Promise<SubOrgResult<SubOrgChild>> {
  return resolveChild(caller, orgPublicId, { allowedStatuses: null, allowSuspended: true, label: 'offboard' }, database);
}

/**
 * The audit identity for a caller.
 *
 * `audit_events.actor_id` is `REFERENCES public.profiles(id)`, so an API key
 * has no value it can legally put there — and substituting the key's owning
 * user would assert a human took an action they did not take. The actor moves
 * into `details` instead.
 *
 * The consumers of that column, and what the shape change does to each, are
 * listed once — above `auditAffiliateStatus` in `orgSubOrgs.ts`. (They are NOT
 * `audit-export.ts`, which this comment used to claim: that endpoint exports
 * anchors and has no `renderAuditDetails`.)
 */
export function subOrgAuditActor(caller: SubOrgCaller): {
  actorId: string | null;
  actor: Record<string, string>;
} {
  if (caller.kind === 'api_key') {
    return {
      actorId: null,
      actor: {
        actor_kind: 'api_key',
        actor_api_key_id: caller.apiKeyId,
        actor_key_prefix: caller.keyPrefix,
      },
    };
  }
  return {
    actorId: caller.userId,
    actor: { actor_kind: 'user', actor_user_id: caller.userId },
  };
}
