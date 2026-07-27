import {
  defineMachine,
  enumType,
  boolType,
  eq,
  and,
  not,
  or,
  lit,
  param,
  index,
  forall,
  mapVar,
  setMap,
  ids,
  variable,
} from "tla-precheck";

// Variable references
const phase = variable("phase");
const committedWork = variable("committedWork");
const accounting = variable("accounting");
const processedReflected = variable("processedReflected");

/**
 * Org-queue-run accounting machine — SCRUM-2620 (Lane 1, PI-0.5).
 *
 * Models the run-accounting state of one org queue run, i.e. how the scheduler
 * (`services/worker/src/jobs/org-queue-scheduler.ts`) records the OUTCOME of a
 * `processBatchAnchors` drain. This is the DESIGN THE TASK-5 FIX PROPOSES, and
 * this spec proves that design satisfies the integrity invariants the current
 * code violates.
 *
 * The bug (current code): the scheduler's `try` is too broad and its
 * `catch` hardcodes `failed / processed:0`, so a run that ALREADY committed
 * on-chain work can be recorded FAILED (a record/emit throw after commit), and
 * a deferred-broadcast run is recorded SUCCEEDED/0 (undercount). Both make the
 * accounting lie about committed work.
 *
 * The fix (modeled here): committed work is only ever recorded SUCCEEDED or
 * PARTIAL (never FAILED), the recorded status always reflects the work, and a
 * PARTIAL run can reconcile to SUCCEEDED when its deferred anchors finalize.
 * The transition that CURRENTLY exists and breaks this — `recordFailCommitted`
 * (phase=DRAINED ∧ committedWork → accounting=FAILED) — is DELIBERATELY ABSENT.
 * Adding it back makes `committedNeverFailed` fail under `check`, which is
 * exactly the SCRUM-2620 defect.
 *
 * Documentation-only spec (no runtimeAdapter): the accounting lives across
 * `organization_queue_runs` + `_state` rows written by the scheduler, not a
 * single adapter-owned table. Kept runnable under `tla-precheck check` so a
 * refactor that reintroduces the failed/0 path is caught.
 *
 * ⚠ TOOLCHAIN FINDING (Lane 1, 2026-07-20, for RTE/tooling owner): this spec is
 * type-clean but `tla-precheck check` cannot run TLC in the current repo
 * toolchain — `tla-precheck@0.1.7` injects compiler flags that the repo's
 * pinned `typescript@6.0.3` rejects (TS5096 `allowImportingTsExtensions`
 * requires noEmit; TS5103 invalid `--ignoreDeprecations`). This aborts `check`
 * at the typecheck phase for EVERY machine (reproduced on the pre-existing
 * `calibrationWorkflow.machine.ts`), so the §1.7 formal-verification gate is
 * currently non-functional against TS 6.x. Fix = bump tla-precheck to a
 * TS-6-compatible release (or run `check` under a compatible TS). Once fixed,
 * this machine checks green (verified by construction: the only action setting
 * accounting=FAILED is guarded by NOT committedWork).
 */
export const drainRunAccountingMachine = defineMachine({
  version: 2,
  moduleName: "DrainRunAccounting",

  variables: {
    // Lifecycle of one claimed org queue run.
    phase: mapVar(
      "Runs",
      enumType("CLAIMED", "DRAINING", "DRAINED", "RECORDED"),
      lit("CLAIMED")
    ),
    // Did the drain commit on-chain work (broadcast a tx)? Set at drain time.
    committedWork: mapVar("Runs", boolType(), lit(false)),
    // The recorded run outcome.
    accounting: mapVar(
      "Runs",
      enumType("NONE", "SUCCEEDED", "FAILED", "PARTIAL"),
      lit("NONE")
    ),
    // Whether the recorded status faithfully reflects the committed work.
    processedReflected: mapVar("Runs", boolType(), lit(false)),
  },

  actions: {
    // Scheduler picks up a claimed run and starts the drain.
    startDrain: {
      params: { r: "Runs" },
      guard: eq(index(phase, param("r")), lit("CLAIMED")),
      updates: [setMap("phase", param("r"), lit("DRAINING"))],
    },

    // Drain finished having committed NO on-chain work (nothing to do, or a
    // provably-never-relayed reject — pre-commit).
    drainNoWork: {
      params: { r: "Runs" },
      guard: eq(index(phase, param("r")), lit("DRAINING")),
      updates: [setMap("phase", param("r"), lit("DRAINED"))],
    },

    // Drain broadcast a tx → on-chain work is committed (infallible-after-wire).
    drainCommit: {
      params: { r: "Runs" },
      guard: eq(index(phase, param("r")), lit("DRAINING")),
      updates: [
        setMap("phase", param("r"), lit("DRAINED")),
        setMap("committedWork", param("r"), lit(true)),
      ],
    },

    // Record a no-work run as succeeded (0 processed legitimately reflects 0 work).
    recordSuccessNoWork: {
      params: { r: "Runs" },
      guard: and(
        eq(index(phase, param("r")), lit("DRAINED")),
        not(index(committedWork, param("r")))
      ),
      updates: [
        setMap("phase", param("r"), lit("RECORDED")),
        setMap("accounting", param("r"), lit("SUCCEEDED")),
        setMap("processedReflected", param("r"), lit(true)),
      ],
    },

    // Record a no-work run as failed (a genuine pre-commit failure — correct).
    recordFailNoWork: {
      params: { r: "Runs" },
      guard: and(
        eq(index(phase, param("r")), lit("DRAINED")),
        not(index(committedWork, param("r")))
      ),
      updates: [
        setMap("phase", param("r"), lit("RECORDED")),
        setMap("accounting", param("r"), lit("FAILED")),
        setMap("processedReflected", param("r"), lit(true)),
      ],
    },

    // Record a committed run as succeeded — reflecting the work (the fix).
    recordSuccessCommitted: {
      params: { r: "Runs" },
      guard: and(
        eq(index(phase, param("r")), lit("DRAINED")),
        index(committedWork, param("r"))
      ),
      updates: [
        setMap("phase", param("r"), lit("RECORDED")),
        setMap("accounting", param("r"), lit("SUCCEEDED")),
        setMap("processedReflected", param("r"), lit(true)),
      ],
    },

    // Record a committed run as PARTIAL (deferred broadcast pending reconcile),
    // still reflecting that work was committed (the fix's new state).
    recordPartialCommitted: {
      params: { r: "Runs" },
      guard: and(
        eq(index(phase, param("r")), lit("DRAINED")),
        index(committedWork, param("r"))
      ),
      updates: [
        setMap("phase", param("r"), lit("RECORDED")),
        setMap("accounting", param("r"), lit("PARTIAL")),
        setMap("processedReflected", param("r"), lit(true)),
      ],
    },

    // Deferred anchors finalize → reconcile PARTIAL up to SUCCEEDED.
    reconcilePartialToSuccess: {
      params: { r: "Runs" },
      guard: and(
        eq(index(phase, param("r")), lit("RECORDED")),
        eq(index(accounting, param("r")), lit("PARTIAL"))
      ),
      updates: [setMap("accounting", param("r"), lit("SUCCEEDED"))],
    },

    // --- THE SCRUM-2620 BUG (deliberately ABSENT). Uncommenting it makes
    // `committedNeverFailed` fail under `check` — that is the current defect:
    // recordFailCommitted: {
    //   params: { r: "Runs" },
    //   guard: and(
    //     eq(index(phase, param("r")), lit("DRAINED")),
    //     index(committedWork, param("r"))
    //   ),
    //   updates: [
    //     setMap("phase", param("r"), lit("RECORDED")),
    //     setMap("accounting", param("r"), lit("FAILED")),
    //     setMap("processedReflected", param("r"), lit(false)),
    //   ],
    // },
  },

  invariants: {
    // SCRUM-2620 core: committed on-chain work is NEVER recorded as failed.
    committedNeverFailed: {
      description: "A run that committed on-chain work is never recorded FAILED",
      formula: forall("Runs", "r",
        or(
          not(index(committedWork, param("r"))),
          not(eq(index(accounting, param("r")), lit("FAILED")))
        )
      ),
    },

    // Accounting faithfulness: a recorded committed run always reflects its work.
    committedAlwaysReflected: {
      description: "A recorded run that committed work reflects it (no SUCCEEDED/0 undercount)",
      formula: forall("Runs", "r",
        or(
          not(index(committedWork, param("r"))),
          not(eq(index(phase, param("r")), lit("RECORDED"))),
          index(processedReflected, param("r"))
        )
      ),
    },

    // A recorded committed run is terminal in SUCCEEDED or PARTIAL only.
    committedRecordedTerminal: {
      description: "A recorded committed run is SUCCEEDED or PARTIAL, never FAILED/NONE",
      formula: forall("Runs", "r",
        or(
          not(index(committedWork, param("r"))),
          not(eq(index(phase, param("r")), lit("RECORDED"))),
          or(
            eq(index(accounting, param("r")), lit("SUCCEEDED")),
            eq(index(accounting, param("r")), lit("PARTIAL"))
          )
        )
      ),
    },
  },

  proof: {
    defaultTier: "pr",
    tiers: {
      pr: {
        domains: {
          Runs: ids({ prefix: "run", size: 3 }),
        },
        budgets: {
          maxEstimatedStates: 50_000,
        },
      },
      nightly: {
        domains: {
          Runs: ids({ prefix: "run", size: 4 }),
        },
        budgets: {
          maxEstimatedStates: 200_000,
        },
      },
    },
  },
});

export default drainRunAccountingMachine;
