/**
 * SCRUM-3972 (CTO ruling R17) — cross-organization webhook fan-out.
 *
 * `dispatchWebhookEvent` has always selected endpoints with a flat
 * `.eq('org_id', orgId)`. This module is the ONLY thing that widens that, and
 * only in one direction: an event owned by organization C may ALSO reach the
 * endpoints of organization P when
 *
 *     C.parent_org_id = P.id  AND  C.parent_approval_status = 'APPROVED'
 *     AND that endpoint's `scope` (migration 0454) is 'self_and_descendants'
 *     AND ENABLE_SUBORG_WEBHOOK_FANOUT is on.
 *
 * ONE HOP BY CONSTRUCTION. We read the event-owning organization's own
 * `parent_org_id` and stop. There is no recursive CTE and no subtree helper —
 * `get_org_subtree` in particular must NEVER be used for this, because it
 * prunes on public-listing consent (migration 0429), so a confidential child
 * would be invisible to an authority decision it should govern.
 *
 * ONE HOP BY CHOICE, NOT BY DATABASE GUARANTEE (CTO review 2026-09-12). An
 * earlier draft of this header justified the single read with
 * "`check_sub_org_depth` bounds depth to one level, so 'descendants' and
 * 'direct children' are the same set". That is not true.
 * `check_sub_org_depth` is a BEFORE trigger that rejects a row only when its
 * PROPOSED PARENT already has a parent; it never asks whether the row being
 * re-parented already has children of its own. So `affiliate(o2, o1)` followed
 * by `affiliate(o1, o3)` reaches `o2 -> o1 -> o3` with both writes accepted —
 * TLC reproduces it in three states in
 * `machines/subOrgWebhookFanout.machine.ts`, and
 * `machines/subOrgListingConsent.machine.ts` found the same shape
 * independently. Deeper chains are therefore REACHABLE, and this module
 * deliberately does not follow them: `o3` receives nothing belonging to `o2`,
 * even scoped `self_and_descendants`. That is the safe direction (narrower
 * than the graph), but it means the user-facing copy must promise direct
 * affiliates only — which it now does.
 *
 * DIRECTION IS ASYMMETRIC AND DELIBERATE. A child endpoint never receives a
 * parent's events. `scope` on a child's endpoint widens toward THAT child's own
 * affiliates, never upward — the read below is always "who is MY parent", never
 * "who are my ancestors' endpoints".
 *
 * NO FAIL-OPEN (builder contract §1). Every lookup here can fail, and a failure
 * is never swallowed and never silently treated as "no fan-out is fine": it is
 * logged at error level, captured to Sentry, and returned in `failures[]`,
 * which makes the dispatch result non-ok. Own-organization delivery still
 * proceeds — that is deliberate liveness, not a fallback: the owning org's feed
 * has nothing to do with the parent lookup, and stopping it would turn a
 * parent-side read error into a data-loss event for an uninvolved tenant. The
 * failure is visible either way.
 *
 * CACHING. `organizations` is a hot table (CLAUDE.md §1.2) and this runs on
 * every dispatch, so two caches sit in front of it, both with a 60 s TTL and
 * both carrying an explicit `expiresAt` that is re-validated against a clock
 * sampled AT THE READ (builder contract §4 — never a timestamp sampled once per
 * run):
 *
 *   1. A global "does ANY active endpoint anywhere ask for descendants?" flag.
 *      Today, in production, the answer is no for all 4 active endpoints, so
 *      this single cached boolean removes the `organizations` read entirely.
 *   2. A per-organization {parentOrgId, approved, publicId} entry.
 *
 * The cost of the cache is bounded staleness: revoking an affiliation stops the
 * cross-org feed within 60 s, not instantly. That is stated in
 * `docs/api/webhooks.md` rather than implied. Errors are never cached.
 *
 * CONFIGURATION. The validated config singleton owns the fan-out flag, as it
 * does for the flag registry. Cloud Run configuration changes replace the
 * revision; they do not mutate process.env in a running process. Tests mock
 * this dependency explicitly rather than adding an unvalidated runtime read.
 */

import { config } from '../config.js';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { Sentry } from '../utils/sentry.js';

/** Endpoint row shape this module returns; a structural subset of delivery.ts's. */
export interface FanoutEndpoint {
  id: string;
  url: string;
  secret_hash: string;
  events: string[];
  is_active: boolean;
  org_id: string;
}

/** Every way this module can fail to answer. All are counted, none is silent. */
export type FanoutFailureKind =
  | 'descendant_endpoint_probe'
  | 'owner_org_lookup'
  | 'parent_endpoint_lookup'
  | 'owner_public_id_missing';

export interface FanoutFailure {
  kind: FanoutFailureKind;
  message: string;
}

export interface FanoutResolution {
  /** Parent endpoints that must ALSO receive this event. Empty is the norm. */
  endpoints: FanoutEndpoint[];
  /**
   * The public slug of the organization that OWNS the event. Required to stamp
   * `org_public_id` on a cross-organization payload; null means we could not
   * establish it, in which case `endpoints` is empty and a failure is recorded.
   */
  ownerOrgPublicId: string | null;
  failures: FanoutFailure[];
}

function emptyResolution(): FanoutResolution {
  return { endpoints: [], ownerOrgPublicId: null, failures: [] };
}

export const FANOUT_CACHE_TTL_MS = 60_000;

/** The same validated setting used by the worker flag registry. */
export function isSubOrgFanoutEnabled(): boolean {
  return config.enableSubOrgWebhookFanout;
}

interface DescendantProbeCache {
  anyExists: boolean;
  expiresAt: number;
}

interface OrgLineage {
  parentOrgId: string | null;
  approved: boolean;
  /** `organizations.suspended` — tenancy ended, independently of approval. */
  suspended: boolean;
  publicId: string | null;
  expiresAt: number;
}

let descendantProbeCache: DescendantProbeCache | null = null;
const orgLineageCache = new Map<string, OrgLineage>();

/** Test seam. Production never calls this; the caches are process-local. */
export function __resetSubOrgFanoutCachesForTest(): void {
  descendantProbeCache = null;
  orgLineageCache.clear();
}

function recordFailure(
  failures: FanoutFailure[],
  kind: FanoutFailureKind,
  message: string,
  context: Record<string, unknown>,
): void {
  logger.error(
    { ...context, fanoutFailure: kind, err: message },
    'Sub-organization webhook fan-out could not be resolved — own-organization delivery proceeds, this dispatch is non-ok',
  );
  Sentry.captureMessage('suborg_webhook_fanout_unresolved', {
    level: 'error',
    tags: { subsystem: 'webhooks', stage: 'suborg_fanout', failure_kind: kind },
    extra: { ...context, message },
  });
  failures.push({ kind, message });
}

/**
 * Is there ANY active endpoint, anywhere, asking for descendant events? One
 * cached boolean that lets the common case skip the `organizations` read.
 * `now` is passed in so the caller's single decision clock governs the TTL.
 *
 * Returns null when the probe itself failed (a failure has been recorded).
 */
async function anyDescendantsEndpointExists(
  now: number,
  failures: FanoutFailure[],
): Promise<boolean | null> {
  const cached = descendantProbeCache;
  if (cached && cached.expiresAt > now) return cached.anyExists;

  // TENANT SCOPE, deliberately global (arkova/missing-org-filter would flag
  // this if it were enabled here; it is not — the rule only runs outside the
  // file list in services/worker/eslint.config.js, and an unused disable
  // directive is itself a lint error under --max-warnings 0):
  // the question is "does ANY tenant subscribe to descendant events", asked so
  // the common answer (no) can skip the per-org hot-table read entirely. It
  // selects `id` only, limit 1, and no row content reaches any tenant.
  const { data, error } = await db
    .from('webhook_endpoints')
    .select('id')
    .eq('scope', 'self_and_descendants')
    .eq('is_active', true)
    .limit(1);

  if (error) {
    recordFailure(failures, 'descendant_endpoint_probe', error.message, {});
    return null;
  }

  const anyExists = (data ?? []).length > 0;
  descendantProbeCache = { anyExists, expiresAt: now + FANOUT_CACHE_TTL_MS };
  return anyExists;
}

/**
 * Resolve the event-owning organization's parent, approval state and public
 * slug. Cached per organization; the entry carries its own `expiresAt` and is
 * re-validated against the clock the caller sampled for THIS dispatch.
 */
async function resolveOwnerLineage(
  orgId: string,
  now: number,
  failures: FanoutFailure[],
): Promise<OrgLineage | null> {
  const cached = orgLineageCache.get(orgId);
  if (cached && cached.expiresAt > now) return cached;

  // TENANT SCOPE: the org IS the filter (see the note above on why this is a
  // comment rather than an eslint-disable directive).
  // This reads the single `organizations` row whose primary key is the
  // event-owning org id, to learn its own parent. There is no wider tenant set
  // to scope to, and an `org_id` predicate on a table whose `id` is the org id
  // would be a tautology, not an isolation control.
  const { data, error } = await db
    .from('organizations')
    .select('parent_org_id, parent_approval_status, suspended, public_id')
    .eq('id', orgId)
    .maybeSingle();

  if (error) {
    recordFailure(failures, 'owner_org_lookup', error.message, { orgId });
    return null;
  }

  const row = data as {
    parent_org_id: string | null;
    parent_approval_status: string | null;
    suspended: boolean | null;
    public_id: string | null;
  } | null;

  const lineage: OrgLineage = {
    parentOrgId: row?.parent_org_id ?? null,
    // Strict equality, not `!== 'REVOKED'`. `parent_approval_status` is
    // nullable (a pending request has no status at all) and NULL must not read
    // as approval — the DB CHECK allows NULL / PENDING / APPROVED / REVOKED.
    approved: row?.parent_approval_status === 'APPROVED',
    // CTO review 2026-09-12. `suspend_suborg` (migration 0290) sets
    // `suspended = true` and does NOT move `parent_approval_status`, so an
    // offboarded affiliate reads 'APPROVED' forever. Approval alone would
    // therefore keep streaming a former affiliate's secured-record public ids
    // to its ex-parent indefinitely. NULL reads as not-suspended, which is the
    // column's own NOT NULL DEFAULT false semantics, not a fail-open: the
    // approval predicate above is the primary gate and it is strict.
    suspended: row?.suspended === true,
    publicId: row?.public_id ?? null,
    expiresAt: now + FANOUT_CACHE_TTL_MS,
  };
  orgLineageCache.set(orgId, lineage);
  return lineage;
}

/**
 * Which parent endpoints must additionally receive this event?
 *
 * Returns an empty resolution — with no failures — whenever the answer is
 * legitimately "none": the flag is off, nobody subscribes to descendants, the
 * org has no parent, or the affiliation is not APPROVED. A non-empty
 * `failures[]` means we could not establish the answer and the caller must
 * treat its dispatch as non-ok.
 */
export async function resolveDescendantFanout(params: {
  orgId: string;
  eventType: string;
  /** The clock for THIS dispatch decision, sampled by the caller. */
  now: number;
}): Promise<FanoutResolution> {
  const { orgId, eventType, now } = params;

  // R16b / D2: dark until the founder flips it. Nothing below runs, so the
  // flag-off path issues exactly zero additional queries.
  if (!isSubOrgFanoutEnabled()) return emptyResolution();

  // CTO review 2026-09-12. The `suborg.*` family is dispatched on the PARENT's
  // own org id by `webhooks/subOrgEvents.ts`, and four of the seven are ALSO
  // dispatched on the affiliate's. Fanning the affiliate-side copy back up to
  // the parent can only duplicate an event the parent was already sent
  // directly — and because those schemas are `.strict()` without
  // `org_public_id`, delivery.ts would refuse the stamped copy, raising an
  // error-level Sentry alarm and marking the dispatch non-ok for a request
  // that was entirely correct. The fan-out exists for the record families a
  // parent cannot otherwise see (`anchor.*` / `credential.*` / `compliance.*`).
  if (eventType.startsWith('suborg.')) return emptyResolution();

  const failures: FanoutFailure[] = [];

  const anyDescendants = await anyDescendantsEndpointExists(now, failures);
  if (anyDescendants === null) return { endpoints: [], ownerOrgPublicId: null, failures };
  if (!anyDescendants) return emptyResolution();

  const lineage = await resolveOwnerLineage(orgId, now, failures);
  if (lineage === null) return { endpoints: [], ownerOrgPublicId: null, failures };
  if (!lineage.parentOrgId || !lineage.approved || lineage.suspended) return emptyResolution();

  // A cross-organization payload MUST name the organization the event belongs
  // to (R16). Without a public slug we cannot say whose event this is, and an
  // unattributed cross-tenant event is worse than an undelivered one.
  if (!lineage.publicId) {
    recordFailure(
      failures,
      'owner_public_id_missing',
      'event-owning organization has no public_id; refusing to deliver an unattributed cross-organization payload',
      { orgId, parentOrgId: lineage.parentOrgId },
    );
    return { endpoints: [], ownerOrgPublicId: null, failures };
  }

  const { data, error } = await db
    .from('webhook_endpoints')
    .select('*')
    .eq('org_id', lineage.parentOrgId)
    .eq('is_active', true)
    .eq('scope', 'self_and_descendants')
    .contains('events', [eventType]);

  if (error) {
    recordFailure(failures, 'parent_endpoint_lookup', error.message, {
      orgId,
      parentOrgId: lineage.parentOrgId,
      eventType,
    });
    return { endpoints: [], ownerOrgPublicId: null, failures };
  }

  return {
    endpoints: (data ?? []) as FanoutEndpoint[],
    ownerOrgPublicId: lineage.publicId,
    failures,
  };
}
