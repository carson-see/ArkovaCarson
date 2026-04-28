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
  count,
  lte,
} from "tla-precheck";

// Variable references
const status = variable("status");
const knotsValid = variable("knotsValid");
const activeCalibration = variable("activeCalibration");

/**
 * Calibration Workflow Machine
 *
 * Models the lifecycle of confidence calibration updates.
 * A CalibrationRun goes through: IDLE → EVALUATING → DERIVING → VALIDATING →
 * STAGING → ACTIVE (or REJECTED at validation/staging).
 *
 * Key invariants:
 * - At most one calibration can be ACTIVE at any time
 * - A calibration can only become ACTIVE if it passed validation
 * - Once REJECTED, a calibration cannot become active
 * - ACTIVE status and activeCalibration flag are consistent
 *
 * Simplifications:
 * - hasEvalData removed: implied by status progression past EVALUATING
 * - improvesAccuracy removed: merged into knotsValid (validation checks both)
 */
export const calibrationWorkflowMachine = defineMachine({
  version: 2,
  moduleName: "CalibrationWorkflow",

  variables: {
    // Lifecycle status of each calibration run
    status: mapVar(
      "Calibrations",
      enumType("IDLE", "EVALUATING", "DERIVING", "VALIDATING", "STAGING", "ACTIVE", "SUPERSEDED", "REJECTED"),
      lit("IDLE")
    ),

    // Whether the derived knots passed validation (monotonic, bounded, improves accuracy)
    knotsValid: mapVar("Calibrations", boolType(), lit(false)),

    // Whether this calibration is the currently active one
    activeCalibration: mapVar("Calibrations", boolType(), lit(false)),
  },

  actions: {
    // Start an eval run to collect confidence vs accuracy data
    startEval: {
      params: { c: "Calibrations" },
      guard: eq(index(status, param("c")), lit("IDLE")),
      updates: [
        setMap("status", param("c"), lit("EVALUATING")),
      ],
    },

    // Eval run completes with sufficient data → derive knots
    evalComplete: {
      params: { c: "Calibrations" },
      guard: eq(index(status, param("c")), lit("EVALUATING")),
      updates: [
        setMap("status", param("c"), lit("DERIVING")),
      ],
    },

    // Eval fails (insufficient data, timeout) → back to IDLE
    evalFail: {
      params: { c: "Calibrations" },
      guard: eq(index(status, param("c")), lit("EVALUATING")),
      updates: [
        setMap("status", param("c"), lit("IDLE")),
      ],
    },

    // Derive new calibration knots from eval data → validate
    deriveKnots: {
      params: { c: "Calibrations" },
      guard: eq(index(status, param("c")), lit("DERIVING")),
      updates: [
        setMap("status", param("c"), lit("VALIDATING")),
      ],
    },

    // Validation passes: knots are monotonic, bounded, and improve accuracy
    validationPass: {
      params: { c: "Calibrations" },
      guard: and(
        eq(index(status, param("c")), lit("VALIDATING")),
        not(index(knotsValid, param("c"))),
      ),
      updates: [
        setMap("status", param("c"), lit("STAGING")),
        setMap("knotsValid", param("c"), lit(true)),
      ],
    },

    // Validation fails: knots non-monotonic, out of bounds, or don't improve
    validationFail: {
      params: { c: "Calibrations" },
      guard: eq(index(status, param("c")), lit("VALIDATING")),
      updates: [
        setMap("status", param("c"), lit("REJECTED")),
      ],
    },

    // Promote staged calibration to active (requires no other active calibration)
    promote: {
      params: { c: "Calibrations" },
      guard: and(
        eq(index(status, param("c")), lit("STAGING")),
        index(knotsValid, param("c")),
        // No other calibration is currently active — must supersede first
        eq(
          count("Calibrations", "x", index(activeCalibration, param("x"))),
          lit(0)
        ),
      ),
      updates: [
        setMap("status", param("c"), lit("ACTIVE")),
        setMap("activeCalibration", param("c"), lit(true)),
      ],
    },

    // Deactivate a currently active calibration (superseded by new one)
    supersede: {
      params: { c: "Calibrations" },
      guard: and(
        eq(index(status, param("c")), lit("ACTIVE")),
        index(activeCalibration, param("c")),
      ),
      updates: [
        setMap("status", param("c"), lit("SUPERSEDED")),
        setMap("activeCalibration", param("c"), lit(false)),
      ],
    },

    // Retry a rejected or superseded calibration (reset to IDLE)
    retry: {
      params: { c: "Calibrations" },
      guard: or(
        eq(index(status, param("c")), lit("REJECTED")),
        eq(index(status, param("c")), lit("SUPERSEDED")),
      ),
      updates: [
        setMap("status", param("c"), lit("IDLE")),
        setMap("knotsValid", param("c"), lit(false)),
      ],
    },

    // Cancel a staged calibration (operator decision)
    cancelStaged: {
      params: { c: "Calibrations" },
      guard: eq(index(status, param("c")), lit("STAGING")),
      updates: [
        setMap("status", param("c"), lit("REJECTED")),
      ],
    },
  },

  invariants: {
    // At most one calibration can be the active calibration at any time
    atMostOneActive: {
      description: "At most one calibration is marked as active",
      formula: lte(
        count("Calibrations", "x",
          index(activeCalibration, param("x"))
        ),
        lit(1)
      ),
    },

    // Active calibrations must have passed validation
    activeImpliesValid: {
      description: "An active calibration must have valid knots",
      formula: forall("Calibrations", "x",
        or(
          not(index(activeCalibration, param("x"))),
          index(knotsValid, param("x"))
        )
      ),
    },

    // Active calibrations must be in ACTIVE status
    activeImpliesActiveStatus: {
      description: "An active calibration must be in ACTIVE status",
      formula: forall("Calibrations", "x",
        or(
          not(index(activeCalibration, param("x"))),
          eq(index(status, param("x")), lit("ACTIVE"))
        )
      ),
    },

    // Rejected calibrations cannot be marked active
    rejectedNotActive: {
      description: "A rejected calibration cannot be marked active",
      formula: forall("Calibrations", "x",
        or(
          not(eq(index(status, param("x")), lit("REJECTED"))),
          not(index(activeCalibration, param("x")))
        )
      ),
    },

    // Staging requires valid knots
    stagingImpliesValid: {
      description: "A staged calibration must have valid knots",
      formula: forall("Calibrations", "x",
        or(
          not(eq(index(status, param("x")), lit("STAGING"))),
          index(knotsValid, param("x"))
        )
      ),
    },
  },

  proof: {
    defaultTier: "pr",
    tiers: {
      pr: {
        domains: {
          Calibrations: ids({ prefix: "c", size: 3 }),
        },
        budgets: {
          maxEstimatedStates: 35_000,
        },
      },
      nightly: {
        domains: {
          Calibrations: ids({ prefix: "c", size: 4 }),
        },
        budgets: {
          maxEstimatedStates: 100_000,
        },
      },
    },
  },
});

export default calibrationWorkflowMachine;
