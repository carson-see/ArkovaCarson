# Documentation-only TLA+ specs

Files in this directory are TLA+ state-machine specs that are **not** verified by `tla-precheck check` because no code-side runtime adapter exists. They live here as design documentation; if a corresponding state machine ever materializes in code, port the file back to `machines/` and re-enable verification.

## calibrationWorkflow.machine.ts

Moved from `machines/` per [SCRUM-1274](https://arkova.atlassian.net/browse/SCRUM-1274) (R3-1).

**Why moved:** ultrareview found the spec but no code-side adapter. `services/worker/src/jobs/calibration-refit.ts:44` is procedural — it never writes a `calibration_runs.status` column or follows the IDLE → EVALUATING → DERIVING → VALIDATING → STAGING → ACTIVE lifecycle the spec models. The spec is documentation only.

**If calibration ever ships as a real state machine:** move this file back to `machines/`, wire up a `runtimeAdapter` in the metadata block, and re-enable `tla-precheck check` against it.
