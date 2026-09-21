/**
 * `ai_credits` period provisioning + debit (SCRUM-4939; migrations 0467/0483).
 *
 * REWRITTEN — the previous version of this machine modeled a protocol that no
 * longer exists. It checked the application-level
 * `select → insert → RE-READ → delete-the-row-I-just-inserted` compensation
 * that PR #2837 put in `cost-tracker.ts`. PR #2999 (migration 0467) DELETED
 * that code and replaced it with a DB-native design, so `deleteOwn` /
 * `deleteOwnFails` / `firstInserter` were a "verified" model of dead code —
 * strictly worse than no model, because the certificate looked green.
 *
 * THE PROTOCOL THAT ACTUALLY EXISTS NOW
 *
 * `public.ensure_ai_credits_period(uuid,integer,timestamptz)` (0467), called by
 * `ensureAICreditsPeriod()` in services/worker/src/ai/cost-tracker.ts:
 *
 *     SET lock_timeout='5s'                      -- function-level GUC
 *     PERFORM pg_advisory_xact_lock(hash(org))   -- serializes provisioning
 *     IF EXISTS (covering row) THEN RETURN true  -- the loser no-ops
 *     INSERT …                                   -- else provision
 *
 * with `ai_credits_org_period_no_overlap` (an EXCLUDE USING gist on
 * `org_id WITH =, tstzrange(period_start, period_end) WITH &&`) as the backstop
 * that makes a second overlapping period impossible even if the guard above
 * were ever bypassed.
 *
 * `public.deduct_ai_credits(uuid,uuid,integer)` (0467, hardened by 0483):
 *
 *     SET search_path='public' SET lock_timeout='5s'   -- 0483 adds lock_timeout
 *     SELECT … ORDER BY created_at,id LIMIT 1 FOR UPDATE
 *     IF no row OR remaining < amount THEN RETURN false
 *     UPDATE … used_this_month = used_this_month + amount
 *
 * WHAT THE MODEL IS FOR — one invariant per mechanism
 *   - `atMostOnePeriodRow` — the EXCLUSION CONSTRAINT. Two active periods for
 *     one org would send every later debit and refund to a different row and
 *     the org would burn credits at 2x.
 *   - `exclusionConstraintNeverFires` — the ADVISORY LOCK, and the reason it
 *     earns its keep even though the constraint already makes duplicates
 *     impossible. `IF EXISTS … INSERT` is two statements: without
 *     serialization two racers both read "no row" and both insert, and the
 *     loser gets a 23P01 exclusion_violation. That error aborts
 *     `ensure_ai_credits_period`, `ensureAICreditsPeriod()` returns false, and
 *     the org's FIRST extraction 503s — the exact bug #2999 exists to remove.
 *     The lock converts that error into the clean `checkFoundRow` no-op. Stated
 *     as an unreachability claim: no racer is ever rejected by the constraint.
 *   - `noDebitWithoutPeriod` / `debitSerializedByRowLock` — the ROW LOCK.
 *   - `lockTimeoutNeverDebits` — fail-CLOSED. A 5 s lock timeout (SQLSTATE
 *     55P03) must never be recorded as a charge; treating it as success is a
 *     free extraction, the defect class ai-extract.ts closed in SCRUM-3502 and
 *     this PR closes in embeddings.ts.
 *
 * MODELING CHOICES, stated so the proof is not read as stronger than it is:
 *   - One domain element = one concurrent request for ONE org's ONE period.
 *     Cross-org and cross-period independence is structural (the advisory-lock
 *     key is `'ai_credits:org:'||org_id` and every statement is scoped by
 *     `org_id` + the covering-period window) and is not modeled.
 *   - Each racer runs the provision stage and then the debit stage, which is
 *     the real request shape (`ensureAICreditsPeriod` then `checkAICredits`
 *     then `deductAICredits`). `checkAICredits` is not modeled: it is a
 *     read-only advisory check and `deduct_ai_credits` re-decides under the row
 *     lock, so it cannot change any outcome here.
 *   - The `IF EXISTS` check and the `INSERT` are SEPARATE actions
 *     (`checkFoundNone` then `insertPeriod`), because they are separate
 *     statements in the function. Collapsing them into one atomic step would
 *     hide the very TOCTOU window the advisory lock is there to close, and
 *     would make `exclusionConstraintNeverFires` pass for the wrong reason.
 *   - `insertPeriod` / `checkFoundRow` release the advisory lock in the same
 *     atomic step that publishes the row, because `pg_advisory_xact_lock` is
 *     released at COMMIT — which is exactly when the INSERT becomes visible.
 *   - `provisionLockTimeout` models the 5 s budget expiring on the advisory
 *     lock. The racer does NOT stop: `ensureAICreditsPeriod` fails soft
 *     (logs at `warn`, returns false) and the caller proceeds to the debit,
 *     which is where it is caught — while the winner is still holding the lock
 *     its INSERT has not committed, so the loser sees no row and takes
 *     `refuseWithoutPeriod` (the worker's 503). That path is reachable in this
 *     model and is the honest representation of the live code.
 *   - `insertRejectedByExclusion` fires when a racer reaches the INSERT and a
 *     covering row has appeared since its own EXISTS check: the constraint
 *     rejects it, the transaction aborts, no row is added and nothing is
 *     debited. Under the advisory lock this action is UNREACHABLE, which is
 *     precisely what `exclusionConstraintNeverFires` asserts.
 *   - `insufficientCredits` covers `remaining < amount` (RETURN false under the
 *     row lock, no debit).
 *
 * Not modeled: the credit arithmetic itself (the DSL has no arithmetic — a
 * debit is a boolean "this racer charged the row"), and refunds. On refunds see
 * 0483's header: 0467's `p_amount <= 0 → RETURN false` guard means every
 * negative-amount refund call currently returns false and refunds nothing.
 * That is a reported regression with its own ticket, not modeled behaviour.
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
const rowInserted = variable("rowInserted");
const debited = variable("debited");
const constraintRejected = variable("constraintRejected");
const advisoryHolder = variable("advisoryHolder");
const rowLockHolder = variable("rowLockHolder");

/** Active period rows covering this org's period. The constraint caps it at 1. */
const periodRows = count(
  "Racers",
  "q",
  eq(index(rowInserted, param("q")), lit(true)),
);

/** Racers currently holding the `FOR UPDATE` row lock inside the debit RPC. */
const debitsInFlight = count(
  "Racers",
  "q",
  eq(index(phase, param("q")), lit("DEBIT_HELD")),
);

export const aiCreditsPeriodProvisionMachine = defineMachine({
  version: 2,
  moduleName: "AiCreditsPeriodProvision",
  variables: {
    phase: mapVar(
      "Racers",
      enumType(
        /** Request started; about to call ensure_ai_credits_period. */
        "START",
        /** Inside ensure_ai_credits_period, holding the advisory lock, about
         *  to run the `IF EXISTS (covering row)` check. */
        "HOLDING",
        /** Still holding the lock; the EXISTS check found nothing and the
         *  INSERT has not run yet. This is the TOCTOU window. */
        "INSERTING",
        /** Provision stage over (provisioned, no-opped, or timed out). */
        "PROVISIONED",
        /** Inside deduct_ai_credits, holding the FOR UPDATE row lock. */
        "DEBIT_HELD",
        /** Request finished. */
        "DONE",
        /** Aborted with no debit recorded: 55P03, or no covering row. */
        "FAILED_CLOSED",
      ),
      lit("START"),
    ),
    /** This racer's INSERT committed the org's period row. */
    rowInserted: mapVar("Racers", boolType(), lit(false)),
    /** This racer's UPDATE committed a debit against that row. */
    debited: mapVar("Racers", boolType(), lit(false)),
    /** This racer's INSERT was rejected by ai_credits_org_period_no_overlap. */
    constraintRejected: mapVar("Racers", boolType(), lit(false)),
    /** Holder of `pg_advisory_xact_lock('ai_credits:org:'||org_id)`. */
    advisoryHolder: scalarVar(optionType(domainType("Racers")), lit(null)),
    /** Holder of the `SELECT … FOR UPDATE` row lock in deduct_ai_credits. */
    rowLockHolder: scalarVar(optionType(domainType("Racers")), lit(null)),
  },

  actions: {
    /** `PERFORM pg_advisory_xact_lock(...)` succeeds — this racer serializes. */
    acquireProvisionLock: {
      params: { r: "Racers" },
      guard: and(
        eq(index(phase, param("r")), lit("START")),
        eq(advisoryHolder, lit(null)),
      ),
      updates: [
        setVar("advisoryHolder", param("r")),
        setMap("phase", param("r"), lit("HOLDING")),
      ],
    },

    /**
     * The 5 s `lock_timeout` fires while waiting for the advisory lock (55P03).
     * `ensureAICreditsPeriod` logs at `warn` and returns false; the request
     * continues to the debit stage, having provisioned nothing.
     */
    provisionLockTimeout: {
      params: { r: "Racers" },
      guard: and(
        eq(index(phase, param("r")), lit("START")),
        not(eq(advisoryHolder, lit(null))),
      ),
      updates: [setMap("phase", param("r"), lit("PROVISIONED"))],
    },

    /**
     * `IF EXISTS (covering row) THEN RETURN true` — the loser of the race
     * observes the committed row and no-ops. This is also the path every
     * already-provisioned org takes on every subsequent request.
     */
    checkFoundRow: {
      params: { r: "Racers" },
      guard: and(
        eq(index(phase, param("r")), lit("HOLDING")),
        not(eq(periodRows, lit(0))),
      ),
      updates: [
        setVar("advisoryHolder", lit(null)),
        setMap("phase", param("r"), lit("PROVISIONED")),
      ],
    },

    /**
     * The EXISTS check found nothing. The INSERT is the NEXT statement, so the
     * racer stays in the function (still holding the lock) with a decision
     * already made on a value it read a statement ago.
     */
    checkFoundNone: {
      params: { r: "Racers" },
      guard: and(
        eq(index(phase, param("r")), lit("HOLDING")),
        eq(periodRows, lit(0)),
      ),
      updates: [setMap("phase", param("r"), lit("INSERTING"))],
    },

    /** The INSERT lands. COMMIT publishes the row and releases the lock. */
    insertPeriod: {
      params: { r: "Racers" },
      guard: and(
        eq(index(phase, param("r")), lit("INSERTING")),
        eq(periodRows, lit(0)),
      ),
      updates: [
        setMap("rowInserted", param("r"), lit(true)),
        setVar("advisoryHolder", lit(null)),
        setMap("phase", param("r"), lit("PROVISIONED")),
      ],
    },

    /**
     * A covering row appeared between this racer's EXISTS check and its INSERT:
     * `ai_credits_org_period_no_overlap` raises 23P01, the transaction aborts,
     * no second row exists and nothing is debited. Unreachable while the
     * advisory lock serializes the two statements — see
     * `exclusionConstraintNeverFires`.
     */
    insertRejectedByExclusion: {
      params: { r: "Racers" },
      guard: and(
        eq(index(phase, param("r")), lit("INSERTING")),
        not(eq(periodRows, lit(0))),
      ),
      updates: [
        setMap("constraintRejected", param("r"), lit(true)),
        setVar("advisoryHolder", lit(null)),
        setMap("phase", param("r"), lit("FAILED_CLOSED")),
      ],
    },

    /** `SELECT … LIMIT 1 FOR UPDATE` acquires the one deterministic row. */
    acquireRowLock: {
      params: { r: "Racers" },
      guard: and(
        eq(index(phase, param("r")), lit("PROVISIONED")),
        not(eq(periodRows, lit(0))),
        eq(rowLockHolder, lit(null)),
      ),
      updates: [
        setVar("rowLockHolder", param("r")),
        setMap("phase", param("r"), lit("DEBIT_HELD")),
      ],
    },

    /**
     * MIGRATION 0483. The row lock is held by someone else and the 5 s
     * `lock_timeout` fires: 55P03, transaction aborted, NO debit. Before 0483
     * this waited to `statement_timeout` instead — same direction of failure,
     * far longer. Either way it must never record a charge, which is what
     * `lockTimeoutNeverDebits` pins.
     */
    debitLockTimeout: {
      params: { r: "Racers" },
      guard: and(
        eq(index(phase, param("r")), lit("PROVISIONED")),
        not(eq(periodRows, lit(0))),
        not(eq(rowLockHolder, lit(null))),
      ),
      updates: [setMap("phase", param("r"), lit("FAILED_CLOSED"))],
    },

    /**
     * No covering row: `deduct_ai_credits` returns false cleanly and the caller
     * refuses the work (ai-extract.ts 503). This is the path a racer takes when
     * its `ensureAICreditsPeriod` timed out and the winner has not committed.
     */
    refuseWithoutPeriod: {
      params: { r: "Racers" },
      guard: and(
        eq(index(phase, param("r")), lit("PROVISIONED")),
        eq(periodRows, lit(0)),
      ),
      updates: [setMap("phase", param("r"), lit("FAILED_CLOSED"))],
    },

    /** `UPDATE … used_this_month = used_this_month + amount` commits. */
    commitDebit: {
      params: { r: "Racers" },
      guard: eq(index(phase, param("r")), lit("DEBIT_HELD")),
      updates: [
        setMap("debited", param("r"), lit(true)),
        setVar("rowLockHolder", lit(null)),
        setMap("phase", param("r"), lit("DONE")),
      ],
    },

    /** `remaining < amount` under the row lock — RETURN false, nothing charged. */
    insufficientCredits: {
      params: { r: "Racers" },
      guard: eq(index(phase, param("r")), lit("DEBIT_HELD")),
      updates: [
        setVar("rowLockHolder", lit(null)),
        setMap("phase", param("r"), lit("DONE")),
      ],
    },
  },

  invariants: {
    atMostOnePeriodRow: {
      description:
        "An org never has two active period rows: pg_advisory_xact_lock serializes provisioning and ai_credits_org_period_no_overlap rejects any overlap, so no debit or refund can ever split across two rows and burn credits at 2x",
      formula: lte(periodRows, lit(1)),
    },

    exclusionConstraintNeverFires: {
      description:
        "No racer is ever rejected by ai_credits_org_period_no_overlap: pg_advisory_xact_lock serializes the EXISTS check and the INSERT, so the second racer takes the clean no-op path instead of a 23P01 that would abort ensure_ai_credits_period and 503 the org's first extraction",
      formula: forall("Racers", "c",
        eq(index(constraintRejected, param("c")), lit(false)),
      ),
    },

    noDebitWithoutPeriod: {
      description:
        "No racer records a debit unless a covering period row exists — a missing row makes deduct_ai_credits return false, never a silent charge",
      formula: forall("Racers", "c",
        or(
          not(eq(index(debited, param("c")), lit(true))),
          not(eq(periodRows, lit(0))),
        ),
      ),
    },

    debitSerializedByRowLock: {
      description:
        "At most one debit is ever in flight against the row: SELECT … FOR UPDATE is the serialization point, so two concurrent debits cannot both read the same remaining balance",
      formula: lte(debitsInFlight, lit(1)),
    },

    lockTimeoutNeverDebits: {
      description:
        "A racer that aborted (55P03 lock timeout, or no covering row) never recorded a debit — the failure is CLOSED, never a hollow success that would bill nothing and render paid work for free",
      formula: forall("Racers", "c",
        or(
          not(eq(index(phase, param("c")), lit("FAILED_CLOSED"))),
          eq(index(debited, param("c")), lit(false)),
        ),
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
        // NOTE: tla-precheck 0.1.7 reads graph equivalence from the TIER, not
        // from `checks` (core/validate.js and core/proof.js both consult
        // `tier.graphEquivalence ?? true`; only `checks.deadlock` is read). The
        // `checks.graphEquivalence` key every machine in this repo writes is
        // therefore inert — harmless here, where the intent was `true` anyway,
        // but it is why the nightly tier below has to say so at tier level.
        graphEquivalence: true,
        // An all-DONE / all-FAILED_CLOSED world is the correct terminal state
        // of a provisioning + debit race, not a liveness bug — same resolution
        // as agentPassport / partnerProvisioning / drainRunAccounting.
        checks: { deadlock: false, graphEquivalence: true },
      },
      nightly: {
        domains: {
          Racers: ids({ prefix: "p", size: 3 }),
        },
        // Graph equivalence is off at three racers, declared at TIER level so
        // tla-precheck actually honours it (see the pr tier's note). Without
        // that, the 100_000 equivalence budget cap applies and the tier cannot
        // run at all: the budget is a product-of-domains UPPER BOUND
        // (7 phases x 2^3 x 2^3 x 2^3 x 4 x 4 = 2_809_856 at three racers), not
        // the reachable graph, which TLC enumerates as a small fraction of it.
        graphEquivalence: false,
        budgets: { maxEstimatedStates: 3_000_000 },
        checks: { deadlock: false, graphEquivalence: false },
      },
    },
  },
});

export default aiCreditsPeriodProvisionMachine;
