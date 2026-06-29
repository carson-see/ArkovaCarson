# scripts/ci/lib/agents.md

Shared library code for CI gate scripts.

## Files
- **`ciContext.ts`** — single source of truth for CI env vars (`BASE_REF_SHA`, `PR_LABELS`, `PR_BODY`), `changedFiles()` helper, `hasLabel()` predicate, and the `LABELS` object mapping override label names. Replaces duplicated env-var declarations across CI scripts.
  - **Live label union (`fix/ci-override-labels-live-read`):** `prLabels` / `hasLabel()` are NOT env-only. `resolvePrLabels()` unions the frozen-payload `PR_LABELS` env with labels fetched LIVE from the GitHub API (`gh api repos/$GITHUB_REPOSITORY/issues/<N>/labels`). The PR number comes from `parsePrNumber()` (`GITHUB_REF=refs/pull/<N>/merge|head`, else `PR_NUMBER`). Reason: ci.yml seeds `PR_LABELS` from the FROZEN `pull_request` event payload, and `pull_request` does not fire on `labeled` — so adding an override label (`count-exact-allowed`, `coverage-drop-allowed`, `handoff-narrative-only`, …) after a run then `gh run rerun` replayed the payload WITHOUT the label, making every label-gated override structurally non-functional on re-runs. `fetchLiveLabels()` is synchronous (`execFileSync`, 10s timeout) and swallows ALL errors to `[]`, so non-PR / push-to-main / missing-`gh` runs fall back to env-only behavior. Requires `pull-requests: read` on the job — every `hasLabel()` caller runs in `policy-lints`, which has it. NOTE: `check-csp-runtime-deps.ts` reads `process.env.PR_LABELS` via its OWN `hasOverrideLabel()` (not ciContext) and is NOT covered by this fix.
- **`workerEnvScan.ts`** — scans `services/worker/src/` for `process.env.*` reads. Used by both CI lint and baseline regenerator to prevent drift. Allowlists `config.ts`, `env.ts`, and test files.

## Conventions
- All CI scripts under `scripts/ci/` should import from this lib rather than re-declaring env helpers.
- `resolveBaseRefOrFail()` fails closed on missing/invalid BASE_REF to prevent silent no-op gates.
