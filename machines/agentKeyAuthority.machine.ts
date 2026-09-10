import {
  defineMachine, variable, mapVar, enumType, boolType, lit, param, index,
  eq, and, or, not, forall, setMap, ids,
} from "tla-precheck";

const status = variable("status");
const keyExists = variable("keyExists");
const keyActive = variable("keyActive");
const wasRevoked = variable("wasRevoked");
const lock = variable("lock");
const mintPhase = variable("mintPhase");
const revokePhase = variable("revokePhase");
const cleanupPhase = variable("cleanupPhase");
const patchPending = variable("patchPending");
const a = param("a");
const at = (value: ReturnType<typeof variable>) => index(value, a);
const is = (value: ReturnType<typeof variable>, expected: string) => eq(at(value), lit(expected));
const unlocked = is(lock, "NONE");

/**
 * SCRUM-4558 / SCRUM-4559: one visible admission, one key, a provider revoke,
 * a stale administrator PATCH and compensation for an uncertain mint response.
 * The parent SHARE/UPDATE locks serialize mint, revoke and cleanup. PATCH's
 * terminal-state trigger reads the version actually updated, not its old read.
 *
 * This bounded model covers committed rows and transaction interleavings. It
 * abstracts failed transactions as releasing locks without changing rows.
 * Shared locks from multiple mints, metadata/org CAS and existing-key UPDATE
 * deadlock retries are verified separately against real PostgreSQL. These two
 * tables do not fit PreCheck's single-table generated adapter subset; the SQL
 * guard/RPC boundary is tested directly, not claimed as generated adapter code.
 */
export const agentKeyAuthorityMachine = defineMachine({
  version: 2,
  moduleName: "AgentKeyAuthority",
  variables: {
    status: mapVar("Agents", enumType("ACTIVE", "REVOKED", "DELETED"), lit("ACTIVE")),
    keyExists: mapVar("Agents", boolType(), lit(false)),
    keyActive: mapVar("Agents", boolType(), lit(false)),
    wasRevoked: mapVar("Agents", boolType(), lit(false)),
    lock: mapVar("Agents", enumType("NONE", "MINT", "REVOKE", "CLEANUP"), lit("NONE")),
    mintPhase: mapVar("Agents", enumType("READ", "LOCKED", "DONE"), lit("READ")),
    revokePhase: mapVar("Agents", enumType("READ", "LOCKED", "DONE"), lit("READ")),
    cleanupPhase: mapVar("Agents", enumType("READ", "LOCKED", "DONE"), lit("READ")),
    // The PATCH has already observed ACTIVE before any concurrent write.
    patchPending: mapVar("Agents", boolType(), lit(true)),
  },
  actions: {
    lockMint: {
      params: { a: "Agents" }, guard: and(unlocked, is(mintPhase, "READ"), is(status, "ACTIVE")),
      updates: [setMap("lock", a, lit("MINT")), setMap("mintPhase", a, lit("LOCKED"))],
    },
    commitMint: {
      params: { a: "Agents" }, guard: and(is(lock, "MINT"), is(mintPhase, "LOCKED")),
      updates: [setMap("keyExists", a, lit(true)), setMap("keyActive", a, lit(true)),
        setMap("lock", a, lit("NONE")), setMap("mintPhase", a, lit("DONE"))],
    },
    failMint: {
      params: { a: "Agents" }, guard: and(is(lock, "MINT"), is(mintPhase, "LOCKED")),
      updates: [setMap("lock", a, lit("NONE")), setMap("mintPhase", a, lit("DONE"))],
    },
    rejectMint: {
      params: { a: "Agents" }, guard: and(unlocked, is(mintPhase, "READ"), not(is(status, "ACTIVE"))),
      updates: [setMap("mintPhase", a, lit("DONE"))],
    },
    lockRevoke: {
      params: { a: "Agents" }, guard: and(unlocked, is(revokePhase, "READ"), is(status, "ACTIVE")),
      updates: [setMap("lock", a, lit("REVOKE")), setMap("revokePhase", a, lit("LOCKED"))],
    },
    commitRevoke: {
      params: { a: "Agents" }, guard: and(is(lock, "REVOKE"), is(revokePhase, "LOCKED")),
      updates: [setMap("status", a, lit("REVOKED")), setMap("wasRevoked", a, lit(true)),
        setMap("keyActive", a, lit(false)), setMap("lock", a, lit("NONE")), setMap("revokePhase", a, lit("DONE"))],
    },
    failRevoke: {
      params: { a: "Agents" }, guard: and(is(lock, "REVOKE"), is(revokePhase, "LOCKED")),
      updates: [setMap("lock", a, lit("NONE")), setMap("revokePhase", a, lit("READ"))],
    },
    lockCleanup: {
      params: { a: "Agents" }, guard: and(unlocked, is(cleanupPhase, "READ")),
      updates: [setMap("lock", a, lit("CLEANUP")), setMap("cleanupPhase", a, lit("LOCKED"))],
    },
    deleteEmptyAdmission: {
      params: { a: "Agents" }, guard: and(is(lock, "CLEANUP"), is(cleanupPhase, "LOCKED"),
        is(status, "ACTIVE"), not(at(keyExists))),
      updates: [setMap("status", a, lit("DELETED")), setMap("lock", a, lit("NONE")), setMap("cleanupPhase", a, lit("DONE"))],
    },
    preserveAdmission: {
      params: { a: "Agents" }, guard: and(is(lock, "CLEANUP"), is(cleanupPhase, "LOCKED"),
        or(not(is(status, "ACTIVE")), at(keyExists))),
      updates: [setMap("lock", a, lit("NONE")), setMap("cleanupPhase", a, lit("DONE"))],
    },
    applyStalePatch: {
      params: { a: "Agents" }, guard: and(unlocked, at(patchPending), is(status, "ACTIVE")),
      updates: [setMap("status", a, lit("ACTIVE")), setMap("patchPending", a, lit(false))],
    },
    rejectStalePatch: {
      params: { a: "Agents" }, guard: and(unlocked, at(patchPending), not(is(status, "ACTIVE"))),
      updates: [setMap("patchPending", a, lit(false))],
    },
  },
  invariants: {
    activeKeyRequiresActiveAgent: {
      description: "A late mint cannot install an active key under a revoked or deleted agent",
      formula: forall("Agents", "a", or(not(at(keyActive)), and(at(keyExists), is(status, "ACTIVE")))),
    },
    revocationRemainsTerminal: {
      description: "Neither a stale PATCH nor compensation can undo an observed revocation",
      formula: forall("Agents", "a", or(not(at(wasRevoked)), is(status, "REVOKED"))),
    },
    cleanupNeverDetachesCommittedKey: {
      description: "An uncertain INSERT response cannot turn its key into an organization key via ON DELETE SET NULL",
      formula: forall("Agents", "a", or(not(at(keyExists)), not(is(status, "DELETED")))),
    },
  },
  proof: {
    defaultTier: "pr",
    tiers: { pr: { domains: { Agents: ids({ prefix: "a", size: 1 }) },
      budgets: { maxEstimatedStates: 100_000 }, checks: { deadlock: false, graphEquivalence: true } } },
  },
});

export default agentKeyAuthorityMachine;
