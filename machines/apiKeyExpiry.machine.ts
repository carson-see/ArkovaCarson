import {
  defineMachine, variable, scalarVar, mapVar, enumType, boolType, lit, param,
  index, eq, and, or, not, setVar, setMap, ids, domainValues,
} from "tla-precheck";

const expiry = variable("expiry");
const revoked = variable("revoked");
const wasRevoked = variable("wasRevoked");
const badWrite = variable("badWrite");
const phase = variable("phase");
const captured = variable("captured");
const target = variable("target");
const acknowledged = variable("acknowledged");
const r = param("r");
const next = param("next");
const allow = eq(param("allow"), lit("yes"));
const at = (v: ReturnType<typeof variable>) => index(v, r);
const pending = eq(at(phase), lit("pending"));
const fresh = and(not(revoked), eq(at(captured), expiry));
const shortens = (after: ReturnType<typeof variable>, before: ReturnType<typeof variable>) => or(
  and(eq(after, lit("SOON")), or(eq(before, lit("FAR")), eq(before, lit("NONE")))),
  and(eq(after, lit("FAR")), eq(before, lit("NONE"))),
);

const invalidWrite = or(revoked, and(not(eq(at(acknowledged), lit("yes"))), shortens(at(target), expiry)));

/**
 * Two expiry requests may both read one live key before either UPDATE commits.
 * SOON < FAR < NONE (no expiry) abstracts their absolute requested timestamps.
 * The no-shortening guard is checked against the captured value; the UPDATE
 * must compare that capture with the current row in the same database statement.
 * A failed comparison returns 409 without a write or an expiry-change audit.
 *
 * Scope: one key, two requests, optional explicit shortening and concurrent
 * revocation. No clock arithmetic, tenant authorization, notice delivery or
 * liveness claim. Already-expired keys and NULL matching are handler tests.
 * This model checks the protocol; it does not own api_keys or generate an adapter.
 */
export const apiKeyExpiryMachine = defineMachine({
  version: 2,
  moduleName: "ApiKeyExpiry",
  variables: {
    expiry: scalarVar(enumType("SOON", "FAR", "NONE"), lit("SOON")),
    revoked: scalarVar(boolType(), lit(false)),
    wasRevoked: scalarVar(boolType(), lit(false)),
    badWrite: scalarVar(boolType(), lit(false)),
    phase: mapVar("Requests", enumType("idle", "pending", "done"), lit("idle")),
    captured: mapVar("Requests", enumType("SOON", "FAR", "NONE"), lit("SOON")),
    target: mapVar("Requests", enumType("SOON", "FAR", "NONE"), lit("SOON")),
    acknowledged: mapVar("Requests", enumType("no", "yes"), lit("no")),
  },
  actions: {
    readAndValidate: {
      params: { r: "Requests", next: "Expiries", allow: "Acknowledgements" },
      guard: and(eq(at(phase), lit("idle")), not(revoked), or(allow, not(shortens(next, expiry)))),
      updates: [
        setMap("phase", r, lit("pending")), setMap("captured", r, expiry),
        setMap("target", r, next), setMap("acknowledged", r, param("allow")),
      ],
    },
    commit: {
      params: { r: "Requests" },
      // The fixed handler's WHERE predicates are one atomic guard.
      guard: and(pending, fresh, not(invalidWrite)),
      updates: [setVar("expiry", at(target)), setMap("phase", r, lit("done"))],
    },
    commitInvalid: {
      params: { r: "Requests" },
      guard: and(pending, fresh, invalidWrite),
      updates: [
        setVar("badWrite", lit(true)), setVar("expiry", at(target)),
        setMap("phase", r, lit("done")),
      ],
    },
    conflict: {
      params: { r: "Requests" },
      guard: and(pending, not(fresh)),
      updates: [setMap("phase", r, lit("done"))],
    },
    revoke: {
      params: {},
      guard: not(revoked),
      updates: [setVar("revoked", lit(true)), setVar("wasRevoked", lit(true))],
    },
  },
  invariants: {
    expiryWritesRespectCurrentState: {
      description: "No stale write changes a revoked key or silently shortens a concurrent extension",
      formula: not(badWrite),
    },
    revocationRemainsTerminal: {
      description: "Expiry changes never reactivate a revoked key",
      formula: or(not(wasRevoked), revoked),
    },
  },
  proof: {
    defaultTier: "pr",
    tiers: {
      pr: {
        domains: {
          Requests: ids({ prefix: "r", size: 2 }),
          Expiries: domainValues("SOON", "FAR", "NONE"),
          Acknowledgements: domainValues("no", "yes"),
        },
        budgets: { maxEstimatedStates: 100_000 },
        checks: { deadlock: false },
        graphEquivalence: true,
      },
    },
  },
});

export default apiKeyExpiryMachine;
