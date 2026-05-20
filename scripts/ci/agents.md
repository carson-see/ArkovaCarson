# scripts/ci/agents.md

CI gate scripts. Each one fails the build with a structured exit code + actionable message when a guardrail trips. Run via `npx tsx scripts/ci/<name>.ts` from a CI workflow.

## Files
- **`check-staging-evidence.ts`** — enforces CLAUDE.md §1.11 / §1.12 staging soak evidence on every PR. Path-based detector classifies the touched files into Tier T1/T2/T3, then verifies the PR body declares the required tier and includes the matching required fields. Field regexes accept optional markdown checkbox prefixes (`- [x]` / `- [ ]`) and use `[^\S\n]*` for horizontal-only whitespace to prevent cross-line value capture (PR #801).
  - **`isStagingToolingOnly()` allowlist** (per-tool meta-PRs that don't need a soak): `scripts/staging/`, `scripts/ci/check-staging-evidence(.test).ts`, `scripts/ci/check-staging-gcloud-policy(.test).ts`, `scripts/ci/lib/`, `scripts/gcp-setup/`, `docs/staging/`, `docs/ops/gemini-model-upgrade.md`, `.github/workflows/ci.yml`, `.github/workflows/staging-evidence.yml`, `CLAUDE.md`, `HANDOFF.md`, `.gitignore`, `.claude/settings.json`, `.claude/hooks/`, `package.json`, `package-lock.json`, `agents.md`.
  - Also allowlisted (PR #798): `eslint-rules/`, `**/eslint.config.(js|cjs|mjs)` — lint config is dev-time tooling with no runtime impact.
  - **No override label exists.** The `staging-soak-skip` label was destroyed 2026-05-07 (PR #733). Real CI/agent-config-only PRs must list every touched file in the allowlist or they fail the gate.
- **`check-npm-install-policy.ts`** — blocks `npm ci` / `npm install` in GitHub Actions workflows and shell deploy helpers unless lifecycle scripts are suppressed with `--ignore-scripts` or a nearby `install-scripts-ok:` comment gives an explicit exception reason.
- **`check-staging-gcloud-policy.ts`** — blocks raw `gcloud run deploy` / `gcloud run services update` commands against `arkova-worker-staging` outside `scripts/staging/deploy.sh`; historical docs need a nearby `staging-gcloud-ok:` reason.
- `check-deploy-lint-parity.ts` (R0-4 / SCRUM-1250) — enforces that `deploy-worker.yml` and `ci.yml` lint steps run the SAME `npm run lint` script per CLAUDE.md §0 rule 9.
- `check-rls-auth-uid-wrap.ts` (SCRUM-1280) — RLS policy lint: `auth.uid()` must always be wrapped in `(SELECT auth.uid())` to allow Postgres planner constant-folding.
- `check-handoff-claims.ts` (R0-6 / SCRUM-1252) — HANDOFF.md verification lint: edits asserting prod state require a verification artifact link.
- `check-sentry-alert-contract.test.ts` — regression test for the revision-drift workflow tags consumed by the documented Sentry alert rule.
- `check-views-security-invoker.ts` — every Postgres view must use `WITH (security_invoker=true)` to prevent RLS bypass.
- `feedback-rules/` — orchestrator + per-rule scripts (R0-7 / SCRUM-1253) for `memory/feedback_*.md` rules.

- **`staging-honesty-preflight.ts`** (SCRUM-1668) — queries a Supabase staging database and reports whether the environment is a clean mirror, has soak artifacts, or is fixture-seeded. 8 checks: (1) PR-only / staging-only migration rows, (2) duplicate names, (3) duplicate versions, (4) known artifact rows, (5) missing SUBMITTED anchors, (6) prod ledger divergence, (7) org topology — single-tenant prod vs multi-org staging seeds, (8) prod facts — pg_cron vacuum-anchors exists, refresh_pipeline_dashboard_cache exists but unscheduled. Checks 7–8 are optional (backward-compatible); live-queried from organizations table and cron schema, with `--prod-facts` CLI fallback. 53 tests in `staging-honesty-preflight.test.ts`.

## Conventions
- Exit 0 = pass; exit 1 = fail with actionable error to stderr.
- Tests colocate as `<name>.test.ts` and run in the main worker vitest config.
- Fail messages must tell the operator (a) what failed, (b) why it matters, (c) how to fix or override.

## Open work
- PR #733 (`destroy-staging-soak-skip`) — still in flight; awaits merge.
