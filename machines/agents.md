# machines/agents.md

TLA+ PreCheck formal verification models for critical state machines.

## Files
- **`bitcoinAnchor.machine.ts`** — formal model of the anchor lifecycle (PENDING -> SUBMITTED -> SECURED, plus REVOKED/EXPIRED/legal-hold transitions). Verified with `tla-precheck`. Any anchor lifecycle change must update this machine first and run `check`.
- **`calibrationWorkflow.machine.ts`** — formal model of confidence calibration workflow (IDLE -> EVALUATING -> DERIVING -> VALIDATING -> COMPLETE).
- **`tsconfig.json`** — TypeScript config for the machines package.

## Conventions
- Edit the machine BEFORE changing production anchor lifecycle code.
- Run `check` after every machine edit to verify invariants hold.
- Uses `tla-precheck` DSL (`defineMachine`, `enumType`, `variable`, `forall`, etc.).
