/**
 * `ensureAICreditsPeriod` concurrent provisioning (SCRUM-4939, PR #2837).
 *
 * `public.ai_credits` has NO unique constraint on `(org_id, period_start)` —
 * only a primary key on `id` — so the worker cannot use `INSERT … ON CONFLICT`
 * and provisioning is a select-then-insert with a real TOCTOU window. Adding
 * the constraint is DDL on a table every extraction reads: its own migration,
 * its own lock-timeout review (CLAUDE.md §1.2), and a T3 PR. The window is
 * therefore closed in application code, and THIS is the protocol being checked:
 *
 *   select covering rows → if none, insert → RE-READ → if more than one row now
 *   covers the period, the racer whose row is NOT the keeper (keeper = lowest
 *   `(created_at, id)`, i.e. the row that existed first) deletes ONLY THE ROW IT
 *   JUST INSERTED, by id.
 *
 * Why it has to be right: `deduct_ai_credits`'s `UPDATE` has no row limit and
 * `ai_credits.reconcile_refund` refunds through the same RPC, so a surviving
 * duplicate makes every later debit increment both rows and every refund
 * decrement both — the org burns credits at 2x for the rest of the month. And
 * the failure mode in the other direction is worse: if the compensation could
 * ever remove the last row, the org is back to the hard 503 this PR exists to
 * remove. `neverZeroRowsOnceProvisioned` is the invariant that matters.
 *
 * Modeling choices, stated so the proof is not read as stronger than it is:
 *   - One domain element = one concurrent request provisioning ONE org's ONE
 *     period. Cross-org and cross-period independence is structural (every
 *     statement is scoped by `org_id` + the covering-period window) and is not
 *     modeled.
 *   - `firstInserter` stands in for the `(created_at, id)` total order. It is a
 *     scalar set once, by whichever insert lands first, which is exactly what
 *     ordering by `created_at, id` resolves to.
 *   - A racer's re-read is assumed to SEE every already-committed insert. Each
 *     PostgREST statement is its own read-committed transaction, so an insert
 *     that committed before the re-read began is visible. A stale re-read that
 *     misses the keeper's row is therefore not modeled — it would leave a
 *     duplicate (not a zero-row state), the same outcome as `deleteOwnFails`.
 *   - `deleteOwnFails` models the compensating DELETE erroring. The code logs
 *     at `error` level and leaves the duplicate for operator reconciliation, so
 *     `settledConvergesToOneRow` is conditioned on no delete having failed —
 *     `neverZeroRowsOnceProvisioned` is NOT conditioned and must hold anyway.
 *
 * Not modeled: the debit/refund arithmetic itself (the DSL has no arithmetic),
 * and whether a row is exhausted. Those are `deduct_ai_credits`'s concern.
 */
import {
  defineMachine,
  enumType,
  boolType,
  domainType,
  optionType,
  eq,
  lte,
  and,
  or,
  not,
  lit,
  param,
  index,
  count,
  forall,
  mapVar,
  scalarVar,
  setMap,
  setVar,
  ids,
  variable,
} from "tla-precheck";

const phase = variable("phase");
const rowAlive = variable("rowAlive");
const deleteFailed = variable("deleteFailed");
const firstInserter = variable("firstInserter");

/** Rows currently covering the org's period. */
const aliveCount = count(
  "Racers",
  "c",
  eq(index(rowAlive, param("c")), lit(true)),
);

export const aiCreditsPeriodProvisionMachine = defineMachine({
  version: 2,
  moduleName: "AiCreditsPeriodProvision",
  variables: {
    phase: mapVar(
      "Racers",
      enumType("START", "SAW_EMPTY", "INSERTED", "DONE"),
      lit("START"),
    ),
    /** This racer's own inserted row still exists. */
    rowAlive: mapVar("Racers", boolType(), lit(false)),
    /** The compensating DELETE errored; the duplicate was left in place. */
    deleteFailed: mapVar("Racers", boolType(), lit(false)),
    /** Stands in for the `(created_at, id)` keeper — set by the first insert. */
    firstInserter: scalarVar(optionType(domainType("Racers")), lit(null)),
  },

  actions: {
    /** Covering-period lookup found nothing — this racer will insert. */
    selectEmpty: {
      params: { r: "Racers" },
      guard: and(
        eq(index(phase, param("r")), lit("START")),
        eq(aliveCount, lit(0)),
      ),
      updates: [setMap("phase", param("r"), lit("SAW_EMPTY"))],
    },

    /**
     * Covering-period lookup found a row — the no-op path, which is what every
     * currently-live prod org takes (16/16 already have a current-period row).
     */
    selectFound: {
      params: { r: "Racers" },
      guard: and(
        eq(index(phase, param("r")), lit("START")),
        not(eq(aliveCount, lit(0))),
      ),
      updates: [setMap("phase", param("r"), lit("DONE"))],
    },

    /** This insert landed first, so this racer's row is the keeper. */
    insertFirst: {
      params: { r: "Racers" },
      guard: and(
        eq(index(phase, param("r")), lit("SAW_EMPTY")),
        eq(firstInserter, lit(null)),
      ),
      updates: [
        setMap("rowAlive", param("r"), lit(true)),
        setVar("firstInserter", param("r")),
        setMap("phase", param("r"), lit("INSERTED")),
      ],
    },

    /** This insert lost the race — a covering row already exists. */
    insertLater: {
      params: { r: "Racers" },
      guard: and(
        eq(index(phase, param("r")), lit("SAW_EMPTY")),
        not(eq(firstInserter, lit(null))),
      ),
      updates: [
        setMap("rowAlive", param("r"), lit(true)),
        setMap("phase", param("r"), lit("INSERTED")),
      ],
    },

    /** Re-read says we are the keeper: keep our row, delete nothing. */
    keepOwn: {
      params: { r: "Racers" },
      guard: and(
        eq(index(phase, param("r")), lit("INSERTED")),
        eq(firstInserter, param("r")),
      ),
      updates: [setMap("phase", param("r"), lit("DONE"))],
    },

    /** Re-read says we lost: delete OUR OWN row, by id. Never another's. */
    deleteOwn: {
      params: { r: "Racers" },
      guard: and(
        eq(index(phase, param("r")), lit("INSERTED")),
        not(eq(firstInserter, param("r"))),
      ),
      updates: [
        setMap("rowAlive", param("r"), lit(false)),
        setMap("phase", param("r"), lit("DONE")),
      ],
    },

    /** The compensating DELETE errored — duplicate left, logged at error. */
    deleteOwnFails: {
      params: { r: "Racers" },
      guard: and(
        eq(index(phase, param("r")), lit("INSERTED")),
        not(eq(firstInserter, param("r"))),
      ),
      updates: [
        setMap("deleteFailed", param("r"), lit(true)),
        setMap("phase", param("r"), lit("DONE")),
      ],
    },
  },

  invariants: {
    neverZeroRowsOnceProvisioned: {
      description:
        "Once any racer has provisioned the period, a covering row always exists — the compensation can never leave the org with zero rows and re-create the 503 this fix removes",
      formula: or(
        eq(firstInserter, lit(null)),
        not(eq(aliveCount, lit(0))),
      ),
    },

    keeperRowNeverDeleted: {
      description:
        "The keeper's row is never removed: a racer may only delete the row it inserted itself, and the keeper by definition never deletes",
      formula: forall("Racers", "c",
        or(
          not(eq(firstInserter, param("c"))),
          eq(index(rowAlive, param("c")), lit(true)),
        ),
      ),
    },

    settledConvergesToOneRow: {
      description:
        "When every racer has finished and no compensating delete errored, exactly one covering row survives — so deduct_ai_credits cannot double-increment",
      formula: or(
        not(and(
          forall("Racers", "c", eq(index(phase, param("c")), lit("DONE"))),
          forall("Racers", "c", eq(index(deleteFailed, param("c")), lit(false))),
        )),
        lte(aliveCount, lit(1)),
      ),
    },
  },

  proof: {
    defaultTier: "pr",
    tiers: {
      pr: {
        domains: {
          Racers: ids({ prefix: "p", size: 2 }),
        },
        budgets: { maxEstimatedStates: 100_000 },
        // An all-DONE world is the correct terminal state of a provisioning
        // race, not a liveness bug — same resolution as agentPassport /
        // partnerProvisioning / drainRunAccounting.
        checks: { deadlock: false, graphEquivalence: true },
      },
      nightly: {
        domains: {
          Racers: ids({ prefix: "p", size: 3 }),
        },
        budgets: { maxEstimatedStates: 100_000 },
        checks: { deadlock: false, graphEquivalence: false },
      },
    },
  },
});

export default aiCreditsPeriodProvisionMachine;
