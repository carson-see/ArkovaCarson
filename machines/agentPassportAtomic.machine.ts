import {
  defineMachine, variable, mapVar, enumType, boolType, lit, param, index,
  eq, and, or, not, forall, setMap, ids,
} from "tla-precheck";

const status = variable("status");
const keyActive = variable("keyActive");
const event = variable("event");
const lock = variable("lock");
const restorePhase = variable("restorePhase");
const revokePhase = variable("revokePhase");
const restoreSnapshot = variable("restoreSnapshot");
const revokeSnapshot = variable("revokeSnapshot");
const restoreAcknowledged = variable("restoreAcknowledged");
const a = param("a");

/**
 * SCRUM-4535 / SCRUM-4536: one provider-suspended agent, one owned suspended
 * key, and overlapping restore/revoke deliveries. The phases expose reads,
 * row locks, transaction failures, committed state, and uncertain responses.
 *
 * The SQL boundary is migration 0448: both writes commit under the same agent
 * lock and the complete snapshot must still match. Key-write errors roll the
 * transaction back. Exact replay is safe only after the complete commit.
 *
 * This is a bounded concurrency model, not a generated database adapter: the
 * operation spans agents plus api_keys and does not fit the single-table
 * adapter subset. Real PostgreSQL fault/concurrency tests verify the SQL
 * implementation of these boundaries. HMAC, timestamp parsing, multiple keys,
 * and suspension ownership remain receiver/binding and SQL test contracts.
 */
export const agentPassportAtomicMachine = defineMachine({
  version: 2,
  moduleName: "AgentPassportAtomic",
  variables: {
    status: mapVar("Agents", enumType("SUSPENDED", "ACTIVE", "REVOKED"), lit("SUSPENDED")),
    keyActive: mapVar("Agents", boolType(), lit(false)),
    event: mapVar("Agents", enumType("SUSPEND", "RESTORE", "REVOKE"), lit("SUSPEND")),
    lock: mapVar("Agents", enumType("NONE", "RESTORE", "REVOKE"), lit("NONE")),
    restorePhase: mapVar("Agents", enumType("NONE", "READ", "LOCKED", "COMMITTED", "DONE"), lit("NONE")),
    revokePhase: mapVar("Agents", enumType("NONE", "READ", "LOCKED", "DONE"), lit("NONE")),
    restoreSnapshot: mapVar("Agents", enumType("SUSPEND", "RESTORE", "REVOKE"), lit("SUSPEND")),
    revokeSnapshot: mapVar("Agents", enumType("SUSPEND", "RESTORE", "REVOKE"), lit("SUSPEND")),
    restoreAcknowledged: mapVar("Agents", boolType(), lit(false)),
  },
  actions: {
    readRestore: {
      params: { a: "Agents" }, guard: eq(index(restorePhase, a), lit("NONE")),
      updates: [setMap("restoreSnapshot", a, index(event, a)), setMap("restorePhase", a, lit("READ"))],
    },
    readRevoke: {
      params: { a: "Agents" }, guard: eq(index(revokePhase, a), lit("NONE")),
      updates: [setMap("revokeSnapshot", a, index(event, a)), setMap("revokePhase", a, lit("READ"))],
    },
    lockRestore: {
      params: { a: "Agents" },
      guard: and(eq(index(restorePhase, a), lit("READ")), eq(index(lock, a), lit("NONE"))),
      updates: [setMap("lock", a, lit("RESTORE")), setMap("restorePhase", a, lit("LOCKED"))],
    },
    lockRevoke: {
      params: { a: "Agents" },
      guard: and(eq(index(revokePhase, a), lit("READ")), eq(index(lock, a), lit("NONE"))),
      updates: [setMap("lock", a, lit("REVOKE")), setMap("revokePhase", a, lit("LOCKED"))],
    },
    commitRestore: {
      params: { a: "Agents" },
      guard: and(eq(index(lock, a), lit("RESTORE")), eq(index(restorePhase, a), lit("LOCKED")),
        eq(index(restoreSnapshot, a), index(event, a)), eq(index(status, a), lit("SUSPENDED"))),
      updates: [setMap("status", a, lit("ACTIVE")), setMap("keyActive", a, lit(true)),
        setMap("event", a, lit("RESTORE")), setMap("restorePhase", a, lit("COMMITTED")), setMap("lock", a, lit("NONE"))],
    },
    failRestoreTransaction: {
      params: { a: "Agents" }, guard: and(eq(index(lock, a), lit("RESTORE")), eq(index(restorePhase, a), lit("LOCKED"))),
      // Failure changes request state only. The agent, key, and clock all roll back.
      updates: [setMap("restorePhase", a, lit("READ")), setMap("lock", a, lit("NONE"))],
    },
    restoreSnapshotChanged: {
      params: { a: "Agents" },
      guard: and(eq(index(lock, a), lit("RESTORE")), eq(index(restorePhase, a), lit("LOCKED")),
        or(not(eq(index(restoreSnapshot, a), index(event, a))), not(eq(index(status, a), lit("SUSPENDED"))))),
      updates: [setMap("restoreSnapshot", a, index(event, a)), setMap("restorePhase", a, lit("READ")), setMap("lock", a, lit("NONE"))],
    },
    commitRevoke: {
      params: { a: "Agents" },
      guard: and(eq(index(lock, a), lit("REVOKE")), eq(index(revokePhase, a), lit("LOCKED")),
        eq(index(revokeSnapshot, a), index(event, a)), not(eq(index(status, a), lit("REVOKED")))),
      updates: [setMap("status", a, lit("REVOKED")), setMap("keyActive", a, lit(false)),
        setMap("event", a, lit("REVOKE")), setMap("revokePhase", a, lit("DONE")), setMap("lock", a, lit("NONE"))],
    },
    revokeSnapshotChanged: {
      params: { a: "Agents" },
      guard: and(eq(index(lock, a), lit("REVOKE")), eq(index(revokePhase, a), lit("LOCKED")),
        not(eq(index(revokeSnapshot, a), index(event, a)))),
      updates: [setMap("revokeSnapshot", a, index(event, a)), setMap("revokePhase", a, lit("READ")), setMap("lock", a, lit("NONE"))],
    },
    acknowledgeRestore: {
      params: { a: "Agents" }, guard: eq(index(restorePhase, a), lit("COMMITTED")),
      updates: [setMap("restoreAcknowledged", a, lit(true)), setMap("restorePhase", a, lit("DONE"))],
    },
    loseRestoreResponse: {
      params: { a: "Agents" }, guard: eq(index(restorePhase, a), lit("COMMITTED")),
      updates: [setMap("restorePhase", a, lit("READ")), setMap("restoreSnapshot", a, index(event, a))],
    },
    retryExactReplay: {
      params: { a: "Agents" },
      guard: and(eq(index(restorePhase, a), lit("READ")), eq(index(event, a), lit("RESTORE"))),
      updates: [setMap("restoreAcknowledged", a, lit(true)), setMap("restorePhase", a, lit("DONE"))],
    },
    stopRestoreAfterRevocation: {
      params: { a: "Agents" },
      guard: and(eq(index(restorePhase, a), lit("READ")), eq(index(status, a), lit("REVOKED"))),
      updates: [setMap("restoreAcknowledged", a, lit(true)), setMap("restorePhase", a, lit("DONE"))],
    },
  },
  invariants: {
    revokedHasNoKey: {
      description: "A completed revocation cannot be undone by a delayed key restore",
      formula: forall("Agents", "a", or(not(eq(index(status, a), lit("REVOKED"))), not(index(keyActive, a)))),
    },
    keyRequiresActiveAgent: {
      description: "Only an active agent can hold the owned active key",
      formula: forall("Agents", "a", or(not(index(keyActive, a)), eq(index(status, a), lit("ACTIVE")))),
    },
    acknowledgedRestorationIsComplete: {
      description: "A successful restore retry cannot hide a failed key write unless a later revoke superseded it",
      formula: forall("Agents", "a", or(not(index(restoreAcknowledged, a)),
        eq(index(status, a), lit("REVOKED")),
        and(eq(index(status, a), lit("ACTIVE")), index(keyActive, a)))),
    },
  },
  proof: {
    defaultTier: "pr",
    tiers: {
      pr: { domains: { Agents: ids({ prefix: "a", size: 1 }) },
        budgets: { maxEstimatedStates: 100_000 }, checks: { deadlock: false, graphEquivalence: true } },
    },
  },
});

export default agentPassportAtomicMachine;
