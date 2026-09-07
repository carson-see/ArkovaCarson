import {
  defineMachine,
  enumType,
  boolType,
  eq,
  or,
  not,
  lit,
  param,
  index,
  forall,
  mapVar,
  setMap,
  ids,
  variable,
} from "tla-precheck";

const status = variable("status");
const keyActive = variable("keyActive");

/**
 * ComputeID AgentPassport ↔ Arkova agent lifecycle (SCRUM-4493 / SCRUM-4494,
 * epic SCRUM-4492).
 *
 * Formal model of the per-agent-row state driven by
 *   services/worker/src/api/v1/agents-computeid.ts   (admit → ACTIVE + key)
 *   services/worker/src/api/v1/webhooks/computeid.ts (passport.* events)
 *   services/worker/src/api/v1/agents.ts             (mint key, admin revoke)
 * and decided by services/worker/src/integrations/computeid/binding.ts.
 *
 *   NONE --admit--> ACTIVE --suspend--> SUSPENDED --reinstate--> ACTIVE
 *                     \--revoke--> REVOKED <--revoke-- SUSPENDED
 *
 * What the proof pins (the partnership's "revocation stops future actions"
 * promise, stated as state predicates):
 *  - REVOKED is terminal — structurally, no action leaves it, and a late
 *    `passport.reinstated` cannot resurrect a revoked agent.
 *  - A key is active ONLY while its agent is ACTIVE: revoke AND suspend
 *    deactivate keys, reinstate restores them, `mintKey` refuses non-ACTIVE
 *    agents. Enforcement lives in `api_keys.is_active` because
 *    `middleware/apiKeyAuth.ts` checks the KEY row only and never joins
 *    `agents.status` — a suspended agent with a live key would still
 *    authenticate. This invariant is what makes suspension real.
 *  - Nothing holds a key before admission.
 *
 * Deliberately NOT modeled: the signed-timestamp ordering guard
 * (`decidePassportEvent`'s stale/at-or-before no-op). It is a per-delivery
 * comparison with no cross-row state; `binding.test.ts` pins it. The DSL has
 * no arithmetic, and a stale delivery is a stutter step TLC would not
 * distinguish from no delivery.
 *
 * VERIFICATION STATUS (2026-09-07): `tla-precheck check agentPassport.machine.ts`
 * (from machines/, pinned node_modules binary) PASSES. Certificate (tier `pr`):
 * proofPassed: true; invariants checked: keyImpliesActive, revokedHasNoKey, suspendedHasNoKey, noKeyBeforeAdmission;
 * graph equivalence equivalent: true (16/16 states,
 * 48/48 edges); TLC 49 generated / 16 distinct
 * states, "No error has been found"; deadlock check off (REVOKED terminal by
 * design). Runs in CI via `npm run verify:machines` (globs machines/*.machine.ts).
 *
 * Adapter status: documentation-only (no runtimeAdapter) — writes go through
 * the hand-written handlers above; PR-B (SCRUM-4497) may promote the binding
 * to owned columns, at which point add ownedTables/ownedColumns and `build`.
 */
export const agentPassportMachine = defineMachine({
  version: 2,
  moduleName: "AgentPassport",

  variables: {
    // Lifecycle status of each agent row. NONE = passport not admitted.
    status: mapVar("Agents", enumType("NONE", "ACTIVE", "SUSPENDED", "REVOKED"), lit("NONE")),
    // Whether the agent currently holds at least one usable API key
    // (`api_keys.is_active = true` for a row with this agent_id).
    keyActive: mapVar("Agents", boolType(), lit(false)),
  },

  actions: {
    // POST /api/v1/agents/computeid/admit — receipt verified offline, row
    // inserted ACTIVE, one agent-scoped key minted in the same request.
    admit: {
      params: { a: "Agents" },
      guard: eq(index(status, param("a")), lit("NONE")),
      updates: [
        setMap("status", param("a"), lit("ACTIVE")),
        setMap("keyActive", param("a"), lit(true)),
      ],
    },

    // POST /api/v1/agents/:agentId/key — refuses any non-ACTIVE agent (409).
    mintKey: {
      params: { a: "Agents" },
      guard: eq(index(status, param("a")), lit("ACTIVE")),
      updates: [setMap("keyActive", param("a"), lit(true))],
    },

    // passport.suspended — keys deactivated so the suspension is enforced at
    // the only place the auth path looks (api_keys.is_active).
    suspend: {
      params: { a: "Agents" },
      guard: eq(index(status, param("a")), lit("ACTIVE")),
      updates: [
        setMap("status", param("a"), lit("SUSPENDED")),
        setMap("keyActive", param("a"), lit(false)),
      ],
    },

    // passport.reinstated — only from SUSPENDED; keys we deactivated for the
    // suspension come back. From REVOKED there is no such action.
    reinstate: {
      params: { a: "Agents" },
      guard: eq(index(status, param("a")), lit("SUSPENDED")),
      updates: [
        setMap("status", param("a"), lit("ACTIVE")),
        setMap("keyActive", param("a"), lit(true)),
      ],
    },

    // passport.revoked (or DELETE /api/v1/agents/:agentId) — terminal; every
    // key for the agent is deactivated.
    revoke: {
      params: { a: "Agents" },
      guard: or(
        eq(index(status, param("a")), lit("ACTIVE")),
        eq(index(status, param("a")), lit("SUSPENDED")),
      ),
      updates: [
        setMap("status", param("a"), lit("REVOKED")),
        setMap("keyActive", param("a"), lit(false)),
      ],
    },
  },

  invariants: {
    // The load-bearing promise: a key authenticates only for an ACTIVE agent.
    keyImpliesActive: {
      description: "An active key exists only while its agent is ACTIVE",
      formula: forall("Agents", "a",
        or(
          not(eq(index(keyActive, param("a")), lit(true))),
          eq(index(status, param("a")), lit("ACTIVE")),
        ),
      ),
    },

    // Spelled out separately so a violation names the state that leaked.
    revokedHasNoKey: {
      description: "A REVOKED agent never holds an active key",
      formula: forall("Agents", "a",
        or(
          not(eq(index(status, param("a")), lit("REVOKED"))),
          eq(index(keyActive, param("a")), lit(false)),
        ),
      ),
    },
    suspendedHasNoKey: {
      description: "A SUSPENDED agent never holds an active key (suspension is enforced, not decorative)",
      formula: forall("Agents", "a",
        or(
          not(eq(index(status, param("a")), lit("SUSPENDED"))),
          eq(index(keyActive, param("a")), lit(false)),
        ),
      ),
    },
    noKeyBeforeAdmission: {
      description: "No key exists for a passport that was never admitted",
      formula: forall("Agents", "a",
        or(
          not(eq(index(status, param("a")), lit("NONE"))),
          eq(index(keyActive, param("a")), lit(false)),
        ),
      ),
    },
  },

  proof: {
    defaultTier: "pr",
    tiers: {
      pr: {
        domains: {
          Agents: ids({ prefix: "a", size: 2 }),
        },
        budgets: { maxEstimatedStates: 10_000 },
        // REVOKED is terminal BY DESIGN — an all-revoked world is a valid end
        // state, not a liveness bug — so TLC's deadlock check is off (same
        // resolution as partnerProvisioning / drainRunAccounting).
        checks: { deadlock: false },
      },
      nightly: {
        domains: {
          Agents: ids({ prefix: "a", size: 4 }),
        },
        budgets: { maxEstimatedStates: 100_000 },
        checks: { deadlock: false },
      },
    },
  },
});

export default agentPassportMachine;
