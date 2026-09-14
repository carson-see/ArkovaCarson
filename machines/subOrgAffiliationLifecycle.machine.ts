import {
  defineMachine,
  enumType,
  boolType,
  eq,
  and,
  or,
  not,
  lit,
  param,
  index,
  forall,
  count,
  lte,
  mapVar,
  setMap,
  modelValues,
  variable,
} from "tla-precheck";

const status = variable("status");
const suspended = variable("suspended");
const holdsCredits = variable("holdsCredits");
const offboardLock = variable("offboardLock");
const allocationReady = variable("allocationReady");

/**
 * Sub-Organization Affiliation Lifecycle (SCRUM-3971, review U1)
 *
 * The API-key sub-organization surface (`services/worker/src/api/v1/
 * orgSubOrgsApiKey.ts`) picks a DIFFERENT child predicate per action — see the
 * lifecycle diagram above `ChildPredicate` in `orgSubOrgsCaller.ts`. The first
 * cut used one predicate per SURFACE instead, and that stranded the wind-down:
 * `offboard` suspends, `revoke` refused suspended children, and `offboard`
 * demanded APPROVED — so whichever call came first made the other unreachable,
 * while the child kept consuming a slot under the affiliate cap (which counts
 * APPROVED rows). This machine is the formal statement of the corrected
 * lifecycle, and exists so a future narrowing of any one predicate has to
 * argue with a model checker rather than with a code comment.
 *
 * WHAT THIS MODELS
 *   `organizations.parent_approval_status` x `organizations.suspended` x
 *   "does this affiliate still hold parent credits", per child, and the five
 *   transitions that move them: request (child-side, JWT), approve, revoke,
 *   allocate and offboard. Offboard is split into reclaim/commit phases under
 *   its child row lock. Allocation's HTTP precheck is separate from its SQL
 *   state check, so a stale precheck cannot be treated as current authority.
 *
 * WHAT THIS DELIBERATELY DOES NOT MODEL
 *   1. WHO may act. Authority is `_suborg_api_key_authorized` in migration
 *      0453 and the `FOR UPDATE` compare-and-set in `updateAffiliateStatus`;
 *      actor identity is not part of this state. It is pinned instead by
 *      `src/tests/sec-0453-suborg-api-key-authority.test.ts`.
 *   2. Integer credit balances. `holdsCredits` is a boolean: the property at
 *      stake is whether allocation can interleave with reclaim/suspension.
 *      Conservation is enforced in SQL by the 0349 invariant.
 *   3. Affiliation depth and re-parenting. `check_sub_org_depth` owns depth and
 *      `subOrgListingConsent.machine.ts` owns the re-parent consent reset.
 *
 * NOT ASSERTED, and worth naming because it is the property the original bug
 * violated: that the wind-down is REACHABLE. That is a liveness/enabledness
 * claim, not a state invariant — a state in which a child is APPROVED and
 * suspended is legitimate for the instant between `offboard` and `revoke`, so
 * no invariant can forbid it. What this file gives instead is the exact guard
 * set: narrow `revoke` to exclude suspended children, or `offboard` to demand
 * APPROVED, and the guards here stop matching the code. The two documented
 * orders (offboard -> revoke, revoke -> offboard) are pinned empirically by
 * `services/worker/src/api/v1/orgSubOrgsApiKey.test.ts`.
 *
 * ADAPTER STATUS: documentation-only, matching `subOrgListingConsent` — no
 * `runtimeAdapter`. These columns live on `organizations`, a table this machine
 * does not own.
 */
export const subOrgAffiliationLifecycleMachine = defineMachine({
  version: 2,
  moduleName: "SubOrgAffiliationLifecycle",

  variables: {
    /**
     * organizations.parent_approval_status. "NONE" stands for the SQL NULL the
     * column still admits (no affiliation has ever been requested).
     */
    status: mapVar(
      "Children",
      enumType("NONE", "PENDING", "APPROVED", "REVOKED"),
      lit("NONE"),
    ),

    /** organizations.suspended — an OPERATIONAL state, not the relationship. */
    suspended: mapVar("Children", boolType(), lit(false)),

    /** Does this affiliate still hold credits the parent allocated to it? */
    holdsCredits: mapVar("Children", boolType(), lit(false)),
    offboardLock: mapVar("Children", boolType(), lit(false)),
    allocationReady: mapVar("Children", boolType(), lit(false)),
  },

  actions: {
    /**
     * The child asks to be affiliated (JWT, child-side — `POST /request`; not
     * on the key surface). REVOKED -> PENDING is included on purpose: the code
     * comment says re-approving a revoked affiliation "is a new decision that
     * goes through request again", and if that path did not exist, REVOKED
     * would be a terminal state and `approve`'s PENDING-only predicate would be
     * a trap rather than a transition.
     */
    request: {
      params: { c: "Children" },
      guard: and(
        not(index(offboardLock, param("c"))),
        or(eq(index(status, param("c")), lit("NONE")), eq(index(status, param("c")), lit("REVOKED"))),
      ),
      updates: [setMap("status", param("c"), lit("PENDING"))],
    },

    /**
     * approve — `resolveChildForApprove`: PENDING only, suspended allowed.
     *
     * The cap guard is migration 0447 / `resolveSubOrgCap`'s D3 rule: approving
     * a pending request adds an affiliate, so it is capped exactly like create.
     * The cap counts APPROVED rows and nothing else, which is precisely why an
     * offboarded-but-never-revoked child used to hold a slot forever.
     *
     * `resolveSubOrgCap` returns `ok: current < limit`, so with CAP = 1 the
     * guard is "no child is APPROVED yet". A first draft wrote it as
     * `current <= limit`, which TLC disproved in five steps — approve(c1) then
     * approve(c2), both admitted because the count was still within the cap
     * when each was checked. An off-by-one in a cap guard is exactly the shape
     * this machine exists to catch, and it caught one in its own first draft.
     */
    approve: {
      params: { c: "Children" },
      guard: and(
        eq(index(status, param("c")), lit("PENDING")),
        not(index(offboardLock, param("c"))),
        lte(
          count("Children", "k", eq(index(status, param("k")), lit("APPROVED"))),
          lit(0),
        ),
      ),
      updates: [setMap("status", param("c"), lit("APPROVED"))],
    },

    /**
     * revoke — `resolveChildForRevoke`: APPROVED (end a live affiliation) or
     * PENDING (refuse a request), suspended allowed. Suspension must NOT gate
     * this: offboard leaves the child suspended, and offboard -> revoke is a
     * documented wind-down order.
     */
    revoke: {
      params: { c: "Children" },
      guard: and(
        not(index(offboardLock, param("c"))),
        or(eq(index(status, param("c")), lit("APPROVED")), eq(index(status, param("c")), lit("PENDING"))),
      ),
      updates: [setMap("status", param("c"), lit("REVOKED"))],
    },

    /** HTTP can approve a request before another transaction offboards. */
    precheckAllocation: {
      params: { c: "Children" },
      guard: and(
        eq(index(status, param("c")), lit("APPROVED")),
        not(index(suspended, param("c"))),
      ),
      updates: [setMap("allocationReady", param("c"), lit(true))],
    },

    /** SQL rechecks current state after acquiring the child row lock (0460). */
    allocate: {
      params: { c: "Children" },
      guard: and(
        index(allocationReady, param("c")),
        not(index(offboardLock, param("c"))),
        eq(index(status, param("c")), lit("APPROVED")),
        not(index(suspended, param("c"))),
      ),
      updates: [
        setMap("holdsCredits", param("c"), lit(true)),
        setMap("allocationReady", param("c"), lit(false)),
      ],
    },

    /**
     * Reclaim and suspend are distinct steps inside the same SQL transaction.
     * The child lock stays held between them, including for an already suspended
     * child being retried. Native PostgreSQL tests pin rollback and lock waiting;
     * this model exposes the interleaving the former atomic action concealed.
     */
    beginOffboard: {
      params: { c: "Children" },
      guard: and(
        not(eq(index(status, param("c")), lit("NONE"))),
        not(index(offboardLock, param("c"))),
      ),
      updates: [
        setMap("offboardLock", param("c"), lit(true)),
        setMap("holdsCredits", param("c"), lit(false)),
      ],
    },
    finishOffboard: {
      params: { c: "Children" },
      guard: index(offboardLock, param("c")),
      updates: [
        setMap("suspended", param("c"), lit(true)),
        setMap("offboardLock", param("c"), lit(false)),
      ],
    },
  },

  invariants: {
    /**
     * THE headline property, and the reason `offboardSubOrgCore` reclaims
     * before it suspends: credits inside a suspended affiliate are credits
     * nobody can spend and nobody can recover through this surface.
     */
    noCreditsStrandedInASuspendedAffiliate: {
      description:
        "A suspended affiliate never still holds parent-allocated credits",
      formula: forall("Children", "c",
        or(
          eq(index(suspended, param("c")), lit(false)),
          eq(index(holdsCredits, param("c")), lit(false)),
        )),
    },

    /**
     * Money never lands on an organization that is not, and never was, an
     * affiliate. Deliberately NOT "holdsCredits implies APPROVED": revoke does
     * not reclaim, so an affiliate revoked before it was offboarded legitimately
     * still holds a balance — that is exactly the revoke -> offboard order the
     * key surface has to keep reachable.
     */
    creditsOnlyOnRealAffiliates: {
      description: "Only an organization with an affiliation history holds credits",
      formula: forall("Children", "c",
        or(
          eq(index(holdsCredits, param("c")), lit(false)),
          not(eq(index(status, param("c")), lit("NONE"))),
        )),
    },

    /**
     * The affiliate cap (migration 0447) counts APPROVED rows. Modelled at 1
     * with two children, which is the smallest domain where a slot held by an
     * offboarded child actually blocks a second approval.
     */
    affiliateCapNeverExceeded: {
      description: "At most CAP affiliates are APPROVED at once",
      formula: lte(
        count("Children", "c", eq(index(status, param("c")), lit("APPROVED"))),
        lit(1),
      ),
    },

    /**
     * Suspension is operational state ON an affiliation. Nothing suspends an
     * organization that never had one — `resolveOwnedChild` still requires
     * `parent_org_id = caller.orgId`, and offboard is the only suspender here.
     */
    suspensionImpliesAffiliationHistory: {
      description: "A suspended organization has had an affiliation",
      formula: forall("Children", "c",
        or(
          eq(index(suspended, param("c")), lit(false)),
          not(eq(index(status, param("c")), lit("NONE"))),
        )),
    },
  },

  proof: {
    defaultTier: "pr",
    tiers: {
      pr: {
        domains: {
          // Two is the smallest domain in which the cap binds: one child holding
          // an APPROVED slot has to be able to block the other.
          Children: modelValues("c", { size: 2, symmetry: true }),
        },
        budgets: { maxEstimatedStates: 100_000 },
      },
    },
  },
});

export default subOrgAffiliationLifecycleMachine;
