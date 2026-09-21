/**
 * `ai_credits` period provisioning + debit (SCRUM-4939; migrations 0467/0483,
 * refunds 0484/0485).
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
 * `public.refund_ai_credits(uuid,uuid,integer,timestamptz)` (0484, re-shaped by
 * 0485) returns credit after work that was charged for did not happen. It locks
 * the SAME row with the SAME predicate as the debit — and, since 0485, over the
 * period window of `coalesce(p_debited_at, now())` rather than the refund's own
 * instant — and floors `used_this_month` at zero. It exists
 * because 0467 closed `deduct_ai_credits` to non-positive amounts while three
 * call sites were issuing refunds through exactly that door — the AI-credit
 * refund regression from 0467, in which every failed extraction stayed charged
 * from 2026-09-19.
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
 *   - `noDebitWithoutPeriod` / `creditMutationSerializedByRowLock` — the ROW
 *     LOCK. Debits and refunds take the same lock on the same row, so at most
 *     one of EITHER is ever in flight.
 *   - `lockTimeoutNeverDebits` — fail-CLOSED. A 5 s lock timeout (SQLSTATE
 *     55P03) must never be recorded as a charge; treating it as success is a
 *     free extraction, the defect class ai-extract.ts closed in SCRUM-3502 and
 *     this PR closes in embeddings.ts.
 *   - `refundNeverExceedsDebits` / `usedNeverNegative` — the refund can only
 *     undo a charge that was actually recorded, and never more of them than
 *     were recorded. These are the model's stand-in for
 *     `GREATEST(used_this_month - p_amount, 0)`: the DSL has no arithmetic, so
 *     a debit and a refund are booleans per racer and the floor is expressed as
 *     "refunds never outnumber debits".
 *   - `lockTimeoutNeverRefunds` — a refund that aborted on 55P03 recorded
 *     nothing, so the worker's error log + `ai_credits.reconcile_refund`
 *     enqueue is the whole remedy and it cannot double-apply silently.
 *
 * MODELING CHOICES, stated so the proof is not read as stronger than it is:
 *   - One domain element = one concurrent request for ONE org's ONE period.
 *     CROSS-ORG independence is structural and is not modeled: the
 *     advisory-lock key is `'ai_credits:org:'||org_id` and every statement is
 *     scoped by `org_id`.
 *
 *     CROSS-PERIOD independence is NOT the same claim, and an earlier version
 *     of this note asserted both at once. It was true of the DEBIT and false of
 *     the REFUND. `deduct_ai_credits` evaluates its window at the instant it
 *     charges, so a debit is always in the period it belongs to. 0484's
 *     `refund_ai_credits` evaluated ITS window at the instant it refunded —
 *     which for a reconciled refund is minutes to days after the debit — so a
 *     refund crossing a month boundary decremented the NEW period and left the
 *     old one overcharged. That is a cross-period interaction the single-period
 *     domain here cannot represent, and calling it structural made it invisible.
 *
 *     0485 makes it structural again by scoping the refund's window with
 *     `coalesce(p_debited_at, now())`, the instant captured at DEBIT time and
 *     carried through every refund site and the reconcile payload. A refund now
 *     addresses the period its debit was taken from, so debit and refund act on
 *     ONE row — which is the premise this single-period domain rests on, and
 *     therefore the premise `refundNeverExceedsDebits` and `usedNeverNegative`
 *     rest on. The residual, still unmodelled, is a caller that supplies a
 *     WRONG `p_debited_at`; that is a type-level property of the worker
 *     (`AICreditDebit` carries the ids and the instant together, captured once),
 *     not of this protocol.
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
 *   - A racer may refund ONLY after `commitDebit` (phase DEBITED). That mirrors
 *     the code: every call site refunds under an `if (deductedCredit)` /
 *     `if (didDebit)` guard, because a refund for work that was never charged
 *     would be a credit grant. `succeedAfterDebit` is the ordinary path where
 *     the work succeeded and the charge stands.
 *   - NOT modelled: a DOUBLE refund. It is reachable in production — a refund
 *     that commits and whose response is lost is re-applied by
 *     `jobs/ai-credit-reconcile.ts`, and there is no idempotency key on the
 *     operation. It is bounded by the SQL `GREATEST(...,0)` floor rather than
 *     by this protocol, and modelling it would need the arithmetic the DSL
 *     does not have. Stated here rather than silently omitted.
 *
 * Not modeled: the credit arithmetic itself. The DSL has no arithmetic, so a
 * debit and a refund are each a boolean per racer ("this racer charged the
 * row" / "this racer returned that charge") and the SQL
 * `GREATEST(used_this_month - p_amount, 0)` floor is expressed as "refunds
 * never outnumber debits".
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
const refunded = variable("refunded");
const advisoryHolder = variable("advisoryHolder");
const rowLockHolder = variable("rowLockHolder");

/** Active period rows covering this org's period. The constraint caps it at 1. */
const periodRows = count(
  "Racers",
  "q",
  eq(index(rowInserted, param("q")), lit(true)),
);

/**
 * Racers holding the `FOR UPDATE` row lock — the debit and the refund take the
 * same lock on the same row, so both phases count.
 */
const creditMutationsInFlight = count(
  "Racers",
  "q",
  or(
    eq(index(phase, param("q")), lit("DEBIT_HELD")),
    eq(index(phase, param("q")), lit("REFUND_HELD")),
  ),
);

/** Charges actually recorded against the period row. */
const debitCount = count(
  "Racers",
  "q",
  eq(index(debited, param("q")), lit(true)),
);

/** Charges actually returned. */
const refundCount = count(
  "Racers",
  "q",
  eq(index(refunded, param("q")), lit(true)),
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
        /** A charge is recorded; the work may still fail and be refunded. */
        "DEBITED",
        /** Inside refund_ai_credits, holding the same FOR UPDATE row lock. */
        "REFUND_HELD",
        /** Request finished. */
        "DONE",
        /** Aborted with no debit recorded: 55P03, or no covering row. */
        "FAILED_CLOSED",
        /** The INSERT was rejected by ai_credits_org_period_no_overlap. */
        "CONSTRAINT_REJECTED",
        /** The refund aborted on 55P03: the charge STANDS, nothing returned. */
        "REFUND_FAILED",
      ),
      lit("START"),
    ),
    /** This racer's INSERT committed the org's period row. */
    rowInserted: mapVar("Racers", boolType(), lit(false)),
    /** This racer's UPDATE committed a debit against that row. */
    debited: mapVar("Racers", boolType(), lit(false)),
    /** This racer's refund committed, returning the charge it had recorded. */
    refunded: mapVar("Racers", boolType(), lit(false)),
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
        setVar("advisoryHolder", lit(null)),
        setMap("phase", param("r"), lit("CONSTRAINT_REJECTED")),
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
        setMap("phase", param("r"), lit("DEBITED")),
      ],
    },

    /** The paid work succeeded — the charge stands, nothing is returned. */
    succeedAfterDebit: {
      params: { r: "Racers" },
      guard: eq(index(phase, param("r")), lit("DEBITED")),
      updates: [setMap("phase", param("r"), lit("DONE"))],
    },

    /**
     * The work failed after the charge, so `refund_ai_credits` (0484) takes the
     * SAME row lock with the SAME predicate the debit used. Reachable only from
     * DEBITED: every call site refunds under `if (deductedCredit)` /
     * `if (didDebit)`, because refunding work that was never charged is a
     * credit grant.
     */
    acquireRefundLock: {
      params: { r: "Racers" },
      guard: and(
        eq(index(phase, param("r")), lit("DEBITED")),
        eq(rowLockHolder, lit(null)),
      ),
      updates: [
        setVar("rowLockHolder", param("r")),
        setMap("phase", param("r"), lit("REFUND_HELD")),
      ],
    },

    /**
     * The refund's 5 s `lock_timeout` fires (55P03). NOTHING is returned and
     * the charge stands: the worker logs at error and enqueues
     * `ai_credits.reconcile_refund`. Pinned by `lockTimeoutNeverRefunds`.
     */
    refundLockTimeout: {
      params: { r: "Racers" },
      guard: and(
        eq(index(phase, param("r")), lit("DEBITED")),
        not(eq(rowLockHolder, lit(null))),
      ),
      updates: [setMap("phase", param("r"), lit("REFUND_FAILED"))],
    },

    /** `UPDATE … used_this_month = GREATEST(used - amount, 0)` commits. */
    commitRefund: {
      params: { r: "Racers" },
      guard: eq(index(phase, param("r")), lit("REFUND_HELD")),
      updates: [
        setMap("refunded", param("r"), lit(true)),
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
        not(eq(index(phase, param("c")), lit("CONSTRAINT_REJECTED"))),
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

    creditMutationSerializedByRowLock: {
      description:
        "At most one credit mutation — debit OR refund — is ever in flight against the row: both take the same SELECT … FOR UPDATE on the same deterministic row, so a debit and a refund cannot interleave on one stale read of the balance",
      formula: lte(creditMutationsInFlight, lit(1)),
    },

    refundNeverExceedsDebits: {
      description:
        "A refund can only undo a charge that was actually recorded: no racer refunds without having debited, so refund_ai_credits can never be turned into a credit grant for work that was never paid for",
      formula: forall("Racers", "c",
        or(
          not(eq(index(refunded, param("c")), lit(true))),
          eq(index(debited, param("c")), lit(true)),
        ),
      ),
    },

    // DERIVED, and deliberately kept. `refundNeverExceedsDebits` is the
    // stronger per-racer statement and implies this one, so this invariant
    // cannot fail on its own in the current model — mutation-testing it needs
    // the per-racer invariant weakened first, and then it does fire. It stays
    // as a ratchet: the aggregate property is the one that matters to a
    // customer's balance, and a future edit that loosens the per-racer
    // guarantee must not be able to pass silently.
    usedNeverNegative: {
      description:
        "Refunds never outnumber debits — the model's stand-in for GREATEST(used_this_month - p_amount, 0), since the DSL has no arithmetic: used_this_month = debits - refunds can never go below zero and a refund can never mint credit beyond what the period consumed",
      formula: lte(refundCount, debitCount),
    },

    lockTimeoutNeverRefunds: {
      description:
        "A refund that aborted on a 55P03 lock timeout returned nothing and the charge stands — so the caller's error log plus the ai_credits.reconcile_refund enqueue is the entire remedy, never a half-applied refund",
      formula: forall("Racers", "c",
        or(
          not(eq(index(phase, param("c")), lit("REFUND_FAILED"))),
          eq(index(refunded, param("c")), lit(false)),
        ),
      ),
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
        // An all-terminal world (DONE / FAILED_CLOSED / CONSTRAINT_REJECTED /
        // REFUND_FAILED) is the correct end of a provisioning + debit + refund
        // race, not a liveness bug — same resolution as agentPassport /
        // partnerProvisioning / drainRunAccounting.
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
        // (11 phases x 2^3 x 2^3 x 2^3 x 4 x 4 = 10_903_552 at three racers),
        // not the reachable graph, which TLC enumerates as a small fraction.
        graphEquivalence: false,
        budgets: { maxEstimatedStates: 11_000_000 },
        checks: { deadlock: false, graphEquivalence: false },
      },
    },
  },
});

export default aiCreditsPeriodProvisionMachine;
