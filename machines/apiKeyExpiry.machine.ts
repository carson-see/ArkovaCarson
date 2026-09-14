import {
  defineMachine, variable, mapVar, enumType, boolType, lit, param, index,
  eq, and, or, not, forall, setMap, ids,
} from "tla-precheck";

const expiry = variable("expiry");
const revoked = variable("revoked");
const wasRevoked = variable("wasRevoked");
const ack = variable("ack");
const patchPending = variable("patchPending");

const k = param("k");
const at = (value: ReturnType<typeof variable>) => index(value, k);
const is = (value: ReturnType<typeof variable>, expected: string) => eq(at(value), lit(expected));

/**
 * SCRUM-5023 — the API-key expiry lifecycle that PATCH /api/v1/keys/:keyId
 * now exposes to owners.
 *
 * TIME IS MODELLED AS AN ORDERING, NOT A CLOCK. `expiry` takes four values
 * ordered by how much life they leave the key: PAST < SOON < FAR < NONE, where
 * NONE (no expiry at all) is infinity. Every real timestamp collapses into one
 * of those, and everything below is about the ORDER, never the arithmetic.
 *
 * WHAT TLC ACTUALLY ADDS HERE, STATED PLAINLY. One property, and it is the one
 * that involves an interleaving:
 *
 *   REVOCATION STAYS TERMINAL ACROSS THE SELECT/UPDATE GAP. The handler reads
 *   the row (`select id, org_id, revoked_at, expires_at, is_active`), decides,
 *   then UPDATEs by id — with no `revoked_at IS NULL` predicate on the UPDATE.
 *   A revoke landing between those two statements means the extend writes
 *   `expires_at` onto a key that has just been withdrawn (`applyStalePatch`
 *   below). The row is then revoked AND carries a future expiry, and the
 *   property that has to survive is that nothing in the system calls it usable.
 *   It does survive — but only because `deriveKeyStatus` ranks `revoked` above
 *   every expiry state and the stale write touches `expires_at` ALONE, never
 *   `is_active` or `revoked_at`. This model is where that ranking stops being a
 *   style preference and becomes a checked property. Reverse the ranking, or
 *   widen the stale UPDATE, and `revocationRemainsTerminal` fails with the
 *   exact interleaving that does it.
 *
 * WHAT IT DOES NOT ADD. The no-silent-shortening rule (409
 * `api_key_expiry_would_shorten` unless `allow_shorten`) is a single-statement
 * PRECONDITION on one handler, not a temporal property: no interleaving makes
 * it true or false, so a model checker can only restate the guard back. It is
 * pinned by `keys-expiry.test.ts` instead. The guards are still transcribed
 * faithfully below — `setFar` shortens only from NONE, `setSoon` shortens from
 * NONE and FAR, and neither shortens from PAST — because a state graph that
 * admitted transitions the route refuses would make the terminal-revocation
 * result a proof about a different program.
 *
 * ALREADY-EXPIRED IS EXEMPT FROM THE SHORTEN GUARD BY DESIGN: every forward
 * move improves a key that is already refusing traffic, and that is the remedy
 * path the dashboard offers straight from the failure. `setSoon` from PAST is
 * therefore unguarded, and the model says so explicitly rather than by
 * omission.
 *
 * SCOPE. Single-row lifecycle only. It does NOT model the notice job's dedupe
 * ledger (that state lives in `audit_events`, not in the key row), org scoping,
 * or authorization — those are the ORG_ADMIN check and its tests, not this.
 * One key is enough: every property here is per-row.
 */
export const apiKeyExpiryMachine = defineMachine({
  version: 2,
  moduleName: "ApiKeyExpiry",
  variables: {
    // PAST < SOON < FAR < NONE, ordered by remaining life. NONE is infinity.
    expiry: mapVar("Keys", enumType("PAST", "SOON", "FAR", "NONE"), lit("FAR")),
    revoked: mapVar("Keys", boolType(), lit(false)),
    // Ghost: a revocation happened. Revocation must stay stuck.
    wasRevoked: mapVar("Keys", boolType(), lit(false)),
    // The request's `allow_shorten` flag, set freely by the caller.
    ack: mapVar("Keys", boolType(), lit(false)),
    // A PATCH that has already read the row as live, before any concurrent
    // write. Models the gap between the handler's SELECT and its UPDATE.
    patchPending: mapVar("Keys", boolType(), lit(true)),
  },
  actions: {
    // ── The caller's acknowledgement flag ────────────────────────────────────
    acknowledge: {
      params: { k: "Keys" },
      guard: not(at(ack)),
      updates: [setMap("ack", k, lit(true))],
    },
    withdrawAcknowledgement: {
      params: { k: "Keys" },
      guard: at(ack),
      updates: [setMap("ack", k, lit(false))],
    },

    // ── Time passing ────────────────────────────────────────────────────────
    approachExpiry: {
      params: { k: "Keys" },
      guard: is(expiry, "FAR"),
      updates: [setMap("expiry", k, lit("SOON"))],
    },
    lapse: {
      params: { k: "Keys" },
      guard: is(expiry, "SOON"),
      updates: [setMap("expiry", k, lit("PAST"))],
    },

    // ── PATCH { expires_in_days: n } ─────────────────────────────────────────
    // Transcribed from keys.ts. A revoked key is refused (409
    // api_key_already_revoked); a shortening needs `allow_shorten`.
    setFar: {
      params: { k: "Keys" },
      guard: and(not(at(revoked)), or(not(is(expiry, "NONE")), at(ack))),
      updates: [setMap("expiry", k, lit("FAR"))],
    },
    setSoon: {
      params: { k: "Keys" },
      guard: and(
        not(at(revoked)),
        or(is(expiry, "PAST"), is(expiry, "SOON"), at(ack)),
      ),
      updates: [setMap("expiry", k, lit("SOON"))],
    },
    // PATCH { expires_in_days: null } — always lengthens, to infinity.
    clearExpiry: {
      params: { k: "Keys" },
      guard: not(at(revoked)),
      updates: [setMap("expiry", k, lit("NONE"))],
    },

    // ── PATCH { is_active: false } ───────────────────────────────────────────
    revoke: {
      params: { k: "Keys" },
      guard: not(at(revoked)),
      updates: [setMap("revoked", k, lit(true)), setMap("wasRevoked", k, lit(true))],
    },

    // ── The SELECT/UPDATE gap ───────────────────────────────────────────────
    // A PATCH that read the row as live and lands after a concurrent revoke.
    // It writes `expires_at` ONLY — never `is_active`, never `revoked_at` — so
    // the revocation stands and the status derivation keeps ranking it first.
    // That is precisely what makes the race benign rather than a bypass, and
    // it is what this model checks.
    applyStalePatch: {
      params: { k: "Keys" },
      guard: at(patchPending),
      updates: [setMap("expiry", k, lit("FAR")), setMap("patchPending", k, lit(false))],
    },
    dropStalePatch: {
      params: { k: "Keys" },
      guard: at(patchPending),
      updates: [setMap("patchPending", k, lit(false))],
    },
  },
  invariants: {
    revocationRemainsTerminal: {
      description:
        "Once revoked, always revoked — a stale extend landing after the revoke cannot bring the key back",
      formula: forall("Keys", "k", or(not(at(wasRevoked)), at(revoked))),
    },
    revokedOnlyByRevocation: {
      description:
        "Nothing but a revoke sets the revoked flag — no expiry write may forge one either",
      formula: forall("Keys", "k", or(not(at(revoked)), at(wasRevoked))),
    },
  },
  proof: {
    defaultTier: "pr",
    tiers: {
      pr: {
        domains: { Keys: ids({ prefix: "k", size: 1 }) },
        budgets: { maxEstimatedStates: 100_000 },
        checks: { deadlock: false },
      },
    },
  },
});

export default apiKeyExpiryMachine;
