# scripts/ci/lib/agents.md

Shared library code for CI gate scripts.

## Files
- **`ciContext.ts`** — single source of truth for CI env vars (`BASE_REF_SHA`, `PR_LABELS`, `PR_BODY`), `changedFiles()` helper, `hasLabel()` predicate, and the `LABELS` object mapping override label names. Replaces duplicated env-var declarations across CI scripts.
- **`workerEnvScan.ts`** — scans `services/worker/src/` for `process.env.*` reads. Used by both CI lint and baseline regenerator to prevent drift. Allowlists `config.ts`, `env.ts`, and test files.

## Conventions
- All CI scripts under `scripts/ci/` should import from this lib rather than re-declaring env helpers.
- `resolveBaseRefOrFail()` fails closed on missing/invalid BASE_REF to prevent silent no-op gates.
