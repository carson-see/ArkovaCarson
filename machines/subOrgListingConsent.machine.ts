import {
  defineMachine,
  optionType,
  domainType,
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

const parentOf = variable("parentOf");
const parentOptin = variable("parentOptin");
const childOptin = variable("childOptin");

/**
 * Sub-Org Listing Consent Machine (SCRUM-3864, epic SCRUM-3863)
 *
 * Formal model of the two-party consent lifecycle added by migration
 * `0429_suborg_tenancy_foundations.sql` and enforced at runtime by the
 * `protect_org_tenancy_fields()` BEFORE UPDATE trigger.
 *
 * An affiliation between a parent org and a sub-org is CONFIDENTIAL by default.
 * It becomes publicly listed only when BOTH parties have consented. The danger
 * this machine exists to rule out is a consent pair that OUTLIVES the
 * affiliation it was given for — which would publish an edge nobody agreed to:
 *
 *   - re-parenting a sub-org must revoke both consents (the affiliation the
 *     parties consented to no longer exists),
 *   - un-affiliating must revoke both,
 *   - an org with no parent must never be in the listed state.
 *
 * WHAT THIS MODELS
 *   The consent STATE machine: which (parentOf, parentOptin, childOptin)
 *   combinations are reachable, and whether "listed" can ever be true without a
 *   live affiliation.
 *
 * WHAT THIS DELIBERATELY DOES NOT MODEL
 *   1. WHO may set each flag. That is an authorization property (the parent
 *      admin must not be able to sign the sub-org's half, because the affiliate
 *      flow makes them an `org_members` owner of every child), and actor
 *      identity is not part of this state. It is proven empirically instead —
 *      checks 5 and 9 of `docs/staging/hakichain-suborgs-2026-09/verify-0429.sql`
 *      exercise both directions against a real PostgreSQL cluster.
 *   2. Credit balances. Conservation is already enforced in the database by the
 *      0349 invariant and exercised by the 0430 proof; modelling integer
 *      balances here would blow up the state space for a property SQL already
 *      guards.
 *   3. Affiliation depth. `check_sub_org_depth` owns that, and it is unchanged
 *      by this epic.
 *
 * ADAPTER STATUS: documentation-only, matching `partnerProvisioning.machine.ts`
 * and `calibrationWorkflow.machine.ts` — no `runtimeAdapter`. The consent
 * columns live on `organizations`, a table this machine does not own (it
 * carries dozens of unrelated columns), so the adapter subset does not fit.
 * The runtime enforcement point is the 0429 trigger; this spec is the proof
 * that the trigger's reset rule is sufficient, and it stays runnable under
 * `tla-precheck check` so a future edit that drops the reset fails here.
 */
export const subOrgListingConsentMachine = defineMachine({
  version: 2,
  moduleName: "SubOrgListingConsent",

  variables: {
    /** organizations.parent_org_id — null when the org is a root. */
    parentOf: mapVar("Orgs", optionType(domainType("Orgs")), lit(null)),

    /** organizations.sub_org_listing_parent_optin */
    parentOptin: mapVar("Orgs", boolType(), lit(false)),

    /** organizations.sub_org_listing_child_optin */
    childOptin: mapVar("Orgs", boolType(), lit(false)),
  },

  actions: {
    /**
     * A parent creates or accepts an affiliation. Consents start false — the
     * columns default false and `createAffiliateOrg` never sets them.
     *
     * `parentOf` is the single source of truth for "is there a live edge". The
     * separate parent_approval_status enum is deliberately NOT modelled: it
     * would multiply the graph past the equivalence budget while adding no
     * consent property, since revoke is modelled as un-affiliation.
     */
    affiliate: {
      params: { c: "Orgs", p: "Orgs" },
      guard: and(
        not(eq(param("c"), param("p"))),
        eq(index(parentOf, param("c")), lit(null)),
        // A sub-org cannot itself be a parent: mirrors the existing
        // "Affiliate organizations cannot create affiliates" rule.
        eq(index(parentOf, param("p")), lit(null)),
      ),
      updates: [
        setMap("parentOf", param("c"), param("p")),
        setMap("parentOptin", param("c"), lit(false)),
        setMap("childOptin", param("c"), lit(false)),
      ],
    },

    /**
     * The parent org is repointed. THE RESET IS THE POINT: consent was given to
     * a specific affiliation, so it cannot carry over to a new one.
     */
    reparent: {
      params: { c: "Orgs", p: "Orgs" },
      guard: and(
        not(eq(param("c"), param("p"))),
        not(eq(index(parentOf, param("c")), lit(null))),
        not(eq(index(parentOf, param("c")), param("p"))),
        eq(index(parentOf, param("p")), lit(null)),
      ),
      updates: [
        setMap("parentOf", param("c"), param("p")),
        setMap("parentOptin", param("c"), lit(false)),
        setMap("childOptin", param("c"), lit(false)),
      ],
    },

    /** Revoke severs the affiliation. Consents go with it. */
    revoke: {
      params: { c: "Orgs" },
      guard: not(eq(index(parentOf, param("c")), lit(null))),
      updates: [
        setMap("parentOf", param("c"), lit(null)),
        setMap("parentOptin", param("c"), lit(false)),
        setMap("childOptin", param("c"), lit(false)),
      ],
    },

    /** The parent org signs its half. Only meaningful on a live affiliation. */
    parentConsents: {
      params: { c: "Orgs" },
      guard: and(
        not(eq(index(parentOf, param("c")), lit(null))),
        eq(index(parentOptin, param("c")), lit(false)),
      ),
      updates: [setMap("parentOptin", param("c"), lit(true))],
    },

    /** The sub-org signs its own half. */
    childConsents: {
      params: { c: "Orgs" },
      guard: and(
        not(eq(index(parentOf, param("c")), lit(null))),
        eq(index(childOptin, param("c")), lit(false)),
      ),
      updates: [setMap("childOptin", param("c"), lit(true))],
    },

    /** Either party can withdraw at any time. */
    parentWithdraws: {
      params: { c: "Orgs" },
      guard: eq(index(parentOptin, param("c")), lit(true)),
      updates: [setMap("parentOptin", param("c"), lit(false))],
    },

    childWithdraws: {
      params: { c: "Orgs" },
      guard: eq(index(childOptin, param("c")), lit(true)),
      updates: [setMap("childOptin", param("c"), lit(false))],
    },
  },

  invariants: {
    /**
     * THE headline property. "Listed" is (parentOptin AND childOptin); the
     * public projections in 0429 emit a child only when both hold. If that pair
     * could ever be true with no parent, an anonymous caller would be shown an
     * affiliation that does not exist.
     */
    listedImpliesAffiliated: {
      description:
        "An org listed publicly as a sub-org always has a live parent affiliation",
      formula: forall("Orgs", "c",
        or(
          not(and(
            eq(index(parentOptin, param("c")), lit(true)),
            eq(index(childOptin, param("c")), lit(true)),
          )),
          not(eq(index(parentOf, param("c")), lit(null))),
        )),
    },

    /**
     * Consent is scoped to a live affiliation in EITHER direction, not just the
     * pair. A single stale half is not a disclosure on its own, but it is how a
     * disclosure gets one signature closer without anyone acting.
     */
    noConsentWithoutAffiliation: {
      description: "Neither consent half survives without a live parent affiliation",
      formula: forall("Orgs", "c",
        or(
          not(eq(index(parentOf, param("c")), lit(null))),
          and(
            eq(index(parentOptin, param("c")), lit(false)),
            eq(index(childOptin, param("c")), lit(false)),
          ),
        )),
    },

    /** An org is never its own parent. */
    noSelfParent: {
      description: "parent_org_id never points at the org itself",
      formula: forall("Orgs", "c", not(eq(index(parentOf, param("c")), param("c")))),
    },

    /**
     * NOT ASSERTED: that the affiliation tree is one level deep.
     *
     * A first draft of this machine claimed `noChainedAffiliation` — an org
     * with a parent is never itself a parent. TLC disproved it in three steps:
     *   affiliate(o2, o1)   -- o1 gains a child
     *   affiliate(o1, o3)   -- o1, already a parent, becomes a child
     * and that behaviour is CORRECT. `check_sub_org_depth` deliberately permits
     * a chain up to depth 3; the code rule is only that a sub-org may not
     * CREATE affiliates, not that a parent may never become one.
     *
     * The invariant was wrong, not the system — recorded here because the
     * consequence is load-bearing: the tree really can be multi-level, which is
     * exactly why 0429 prunes `get_org_subtree` at the RECURSIVE term rather
     * than filtering the final aggregate. A confidential org must hide the
     * branch beneath it, not just itself. That pruning is a projection property
     * rather than a state property, so it is proven in SQL instead — check 15
     * of verify-0429.sql ("hidden child also hides its consenting grandchild").
     */
  },

  proof: {
    defaultTier: "pr",
    tiers: {
      pr: {
        domains: {
          // Three is the smallest domain that can express "re-parent from one
          // parent to a DIFFERENT parent", which is the transition the reset
          // rule exists for.
          Orgs: modelValues("o", { size: 3, symmetry: true }),
        },
        budgets: { maxEstimatedStates: 100_000 },
      },
    },
  },
});

export default subOrgListingConsentMachine;
