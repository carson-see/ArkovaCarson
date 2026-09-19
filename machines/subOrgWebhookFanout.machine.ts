import {
  defineMachine,
  variable,
  scalarVar,
  mapVar,
  boolType,
  optionType,
  domainType,
  lit,
  param,
  index,
  eq,
  and,
  or,
  not,
  forall,
  setVar,
  setMap,
  modelValues,
} from 'tla-precheck';

const parentOf = variable('parentOf');
const approved = variable('approved');
const suspended = variable('suspended');
const wantsDescendants = variable('wantsDescendants');
const flagOn = variable('flagOn');

/**
 * Cross-organization webhook fan-out (SCRUM-3972, CTO review 2026-09-12).
 *
 * `services/worker/src/webhooks/suborg-fanout.ts` decides whether an event
 * OWNED by organization C may ALSO be delivered to an endpoint of organization
 * P. The decision is a conjunction of four independently mutable facts:
 *
 *   parentOf[C] = P              organizations.parent_org_id
 *   approved[C]                  organizations.parent_approval_status = 'APPROVED'
 *   NOT suspended[C]             organizations.suspended  (added by this review)
 *   wantsDescendants[P]          webhook_endpoints.scope = 'self_and_descendants'
 *   flagOn                       ENABLE_SUBORG_WEBHOOK_FANOUT
 *
 * WHAT THIS MODELS
 *   The reachable shapes of the affiliation graph under the REAL triggers and
 *   routes that mutate it, and which (owner, recipient) pairs the fan-out
 *   predicate admits in each of them. The question it exists to answer is not
 *   "does the conjunction hold" — that is true by construction and would be a
 *   vacuous invariant — but "what shapes can the affiliation graph actually
 *   REACH", because the module's one-hop justification is a claim about the
 *   graph, not about the predicate.
 *
 * WHAT THIS DELIBERATELY DOES NOT MODEL
 *   1. The 60 s lineage cache. Staleness is a liveness bound (an event may be
 *      delivered up to a minute after a revocation), not a reachable-state
 *      property, and modelling a clock would multiply the graph for a bound
 *      already stated in docs/api/webhooks.md.
 *   2. Endpoint multiplicity. `wantsDescendants[P]` is "P has at least one
 *      active endpoint scoped self_and_descendants"; per-endpoint event
 *      subscription is a filter applied after this decision, and it can only
 *      narrow the recipient set.
 *   3. Payload attribution. That `org_public_id` is stamped and re-validated is
 *      a per-message property, proven in delivery.suborgScope.test.ts.
 *
 * ADAPTER STATUS: documentation-only, like partnerProvisioning and
 * subOrgListingConsent — the state lives across `organizations` and
 * `webhook_endpoints`, two tables this machine does not own.
 */
export const subOrgWebhookFanoutMachine = defineMachine({
  version: 2,
  moduleName: 'SubOrgWebhookFanout',

  variables: {
    /** organizations.parent_org_id — null when the org is a root. */
    parentOf: mapVar('Orgs', optionType(domainType('Orgs')), lit(null)),
    /** parent_approval_status = 'APPROVED'. NULL and PENDING both read false. */
    approved: mapVar('Orgs', boolType(), lit(false)),
    /** organizations.suspended — set by suspend_suborg, cleared by unsuspend. */
    suspended: mapVar('Orgs', boolType(), lit(false)),
    /** This org has an active endpoint with scope = 'self_and_descendants'. */
    wantsDescendants: mapVar('Orgs', boolType(), lit(false)),
    /** ENABLE_SUBORG_WEBHOOK_FANOUT. Env-backed, flipped by the founder. */
    flagOn: scalarVar(boolType(), lit(false)),
  },

  actions: {
    /**
     * `POST /org/sub-orgs/create` (and `/request`). The guard is
     * `check_sub_org_depth` AS WRITTEN: a BEFORE trigger that rejects the row
     * only when the *proposed parent* already has a parent of its own. It
     * inspects nothing else — in particular it does not ask whether the CHILD
     * already has children.
     */
    affiliate: {
      params: { c: 'Orgs', p: 'Orgs' },
      guard: and(
        not(eq(param('c'), param('p'))),
        eq(index(parentOf, param('c')), lit(null)),
        eq(index(parentOf, param('p')), lit(null)),
      ),
      updates: [
        setMap('parentOf', param('c'), param('p')),
        setMap('approved', param('c'), lit(false)),
      ],
    },

    /** `POST /org/sub-orgs/approve`. */
    approve: {
      params: { c: 'Orgs' },
      guard: and(
        not(eq(index(parentOf, param('c')), lit(null))),
        not(index(approved, param('c'))),
      ),
      updates: [setMap('approved', param('c'), lit(true))],
    },

    /** `POST /org/sub-orgs/revoke`. The edge stays; the approval does not. */
    revoke: {
      params: { c: 'Orgs' },
      guard: index(approved, param('c')),
      updates: [setMap('approved', param('c'), lit(false))],
    },

    /**
     * `suspend_suborg` (migration 0290) / `POST /org/sub-orgs/offboard`.
     * THE POINT: it moves `suspended` and leaves `approved` exactly where it
     * was. An offboarded affiliate reads APPROVED forever.
     */
    suspend: {
      params: { c: 'Orgs' },
      guard: and(
        not(eq(index(parentOf, param('c')), lit(null))),
        not(index(suspended, param('c'))),
      ),
      updates: [setMap('suspended', param('c'), lit(true))],
    },

    /** `unsuspend_suborg`. Likewise leaves `approved` untouched. */
    unsuspend: {
      params: { c: 'Orgs' },
      guard: index(suspended, param('c')),
      updates: [setMap('suspended', param('c'), lit(false))],
    },

    /** An org admin sets an endpoint to scope = 'self_and_descendants'. */
    optIn: {
      params: { p: 'Orgs' },
      guard: not(index(wantsDescendants, param('p'))),
      updates: [setMap('wantsDescendants', param('p'), lit(true))],
    },

    /** ...and back to 'self', or deactivates/deletes the endpoint. */
    optOut: {
      params: { p: 'Orgs' },
      guard: index(wantsDescendants, param('p')),
      updates: [setMap('wantsDescendants', param('p'), lit(false))],
    },

    enableFanout: { params: {}, guard: not(flagOn), updates: [setVar('flagOn', lit(true))] },
    disableFanout: { params: {}, guard: flagOn, updates: [setVar('flagOn', lit(false))] },
  },

  invariants: {
    /**
     * The kill switch is absolute: with the flag off, no (owner, recipient)
     * pair is admitted no matter what the affiliation graph looks like. This is
     * the property the founder is being asked to rely on when the PR ships
     * dark, and it is the one that would break if any later refactor moved the
     * flag check below a cache or into a per-endpoint branch.
     */
    darkMeansDark: {
      description: 'With ENABLE_SUBORG_WEBHOOK_FANOUT off, no cross-organization pair is eligible',
      formula: or(
        flagOn,
        forall('Orgs', 'c',
          forall('Orgs', 'p',
            not(and(
              eq(index(parentOf, param('c')), param('p')),
              index(approved, param('c')),
              not(index(suspended, param('c'))),
              index(wantsDescendants, param('p')),
              flagOn,
            )))),
      ),
    },

    /**
     * An organization is never eligible to receive its own events "across" the
     * boundary — the fan-out copy carries `org_public_id` and a self-addressed
     * cross-org copy would duplicate the own-org delivery.
     */
    noSelfFanout: {
      description: 'No organization is ever its own fan-out counterparty',
      formula: forall('Orgs', 'c', not(eq(index(parentOf, param('c')), param('c')))),
    },

    /**
     * NOT ASSERTED: that the affiliation graph is at most one level deep.
     *
     * `suborg-fanout.ts`'s header justified reading only `parentOf[C]` with:
     * "Depth is additionally bounded in the database by check_sub_org_depth
     * (one level), so 'descendants' and 'direct children' are the same set."
     * The first half is a fair reading of the trigger; the conclusion is not.
     *
     * `check_sub_org_depth` is a BEFORE trigger that rejects a row whose
     * PROPOSED PARENT already has a parent. It never asks whether the row being
     * re-parented already has children. So the ordering
     *
     *     affiliate(o2, o1)   -- o1 gains a child; o1 has no parent, allowed
     *     affiliate(o1, o3)   -- o1 gains a parent; o3 has no parent, allowed
     *
     * reaches o2 -> o1 -> o3, a two-level chain, with both writes accepted.
     * `machines/subOrgListingConsent.machine.ts` recorded the same counterexample
     * independently for the consent projection. TLC reproduces it here in three
     * states from the initial predicate:
     *
     *   State 1  parentOf = (o1 :> NULL @@ o2 :> NULL @@ o3 :> NULL)
     *   State 2  affiliate(o2, o1)  ->  parentOf = (o1 :> NULL @@ o2 :> o1 ...)
     *   State 3  affiliate(o1, o3)  ->  parentOf = (o1 :> o3   @@ o2 :> o1 ...)
     *
     * CONSEQUENCE FOR THIS FEATURE — and it is not a leak. The fan-out reads
     * exactly one hop, so o2's events reach o1 and stop; o3 receives nothing
     * belonging to o2 even with scope = 'self_and_descendants'. The code is
     * strictly NARROWER than the graph, which is the safe direction. What is
     * wrong is the JUSTIFICATION and the copy built on it: "descendants" and
     * "direct children" are not the same set, and the picker option reading
     * "This organization and its affiliated organizations" over-promises for a
     * parent that sits above a two-level chain. Fixed in copy.ts; the module
     * header now says one hop BY CHOICE rather than by database guarantee.
     *
     * ALSO NOT ASSERTED: that an APPROVED affiliate is never suspended. It can
     * be — `suspend` above moves `suspended` and leaves `approved` alone — and
     * that reachable combination is precisely why suborg-fanout.ts needs the
     * `NOT suspended` conjunct as well as the approval one. If the two could
     * not diverge, that conjunct would be dead code.
     */
  },

  proof: {
    defaultTier: 'pr',
    tiers: {
      pr: {
        domains: {
          // Three is the smallest domain that can express the re-ordering
          // counterexample above (child, middle, new grandparent).
          Orgs: modelValues('o', { size: 3, symmetry: true }),
        },
        budgets: { maxEstimatedStates: 100_000 },
      },
    },
  },
});

export default subOrgWebhookFanoutMachine;
