# .github/workflows/ — CI/CD Workflows

## Files

| File | Purpose | Jira |
|------|---------|------|
| `ci.yml` | Secret scan, dependency audit, TDD enforcement, typecheck, lint, coverage-monotonic, handoff-claims, feedback-rules, count:'exact'-baseline | SCRUM-1248/1249/1252/1253/1254 |
| `deploy-worker.yml` | Cloud Run worker deployment. Worker lint uses `npm run lint` (matches CI). | SCRUM-1250 |
| `migration-drift.yml` | Read-only diff: local migrations vs prod applied set. Prevents the scorecard-outage class of bug. | SCRUM-908 |
| `revision-drift.yml` | 10-min cron — fetch worker `/health.git_sha`, compare to `git rev-parse origin/main`, fire Sentry on drift > 1h or `missing-sha`. | SCRUM-1247 |

`staging-evidence.yml` passes both `BASE_REF_SHA` and `HEAD_REF_SHA` into `scripts/ci/check-staging-evidence.ts`; the gate compares those SHAs against the PR-body evidence. Exact PR head SHA must always match. Base SHA movement is impact-assessed: T0 docs/tests/CI/tooling-only drift can preserve soak evidence with an approved `Base drift impact:` note, while runtime/schema/staging/deploy drift still fails closed.

The root `typecheck-lint` job also runs `npm run lint:batch-drain-evidence`. Keep that focused command current when a batch-drain evidence, admission, crash, observation, or shared time/parser file is added; local-only lint is not an enforceable gate.

## SCRUM-1068 — Sonatype SCA

- `ci.yml` includes a non-blocking `sonatype-sca` PR job for the first sprint.
- The local GPL/AGPL/SSPL deny-list is always enforced with `npm run security:license-denylist`; legacy `snarkjs` GPL transitive packages are documented in `scripts/security/license-denylist.allowlist.json`.
- Sonatype Lifecycle remote evaluation runs only when `SONATYPE_LIFECYCLE_URL`, `SONATYPE_LIFECYCLE_USERNAME`, `SONATYPE_LIFECYCLE_PASSWORD`, and `SONATYPE_LIFECYCLE_APPLICATION_ID` secrets exist.

## Patterns

- Workflows use pinned action SHAs (not `@v4` tags) for supply-chain safety.
- External downloads (e.g. `tla2tools.jar`) MUST verify SHA256. See ci.yml's `Pin TLA2TOOLS_JAR` step for the canonical pattern (SCRUM-1248 / R0-2); when the upstream release binary changes, refresh the pin with a local `curl -fsSL <release-url> | shasum -a 256` check and update the inline date.
- `migration-drift.yml` is read-only — it never applies or modifies anything.
- Exempt-list changes in `migration-drift.yml` require a code comment + Jira ticket.
- Temporary PR #841 remediation exemptions are only for the renumbered 0314/0315 schema work after production already claimed 0313 for anchors index consolidation; remove them after operator-applied prod reconciliation.
- Secrets: `arkova1/supabase_access` in GCP Secret Manager for migration drift, `arkova1/sonar_cloud_token` for the SonarCloud config guard (exported as `SONARCLOUD_TOKEN`), `SUPABASE_PROJECT_REF`, `SENTRY_DSN_OPS` (revision-drift Sentry alerts).
- Revision-drift Sentry tags must match `infra/sentry/alert-rules.json`: `source=revision-drift`, `story`, `deployed_sha`, and `head_sha`.
- Deploy gate ≡ CI lint job: deploy-worker.yml + ci.yml `Lint worker` step BOTH invoke `npm run lint` from `services/worker/`. Drift between them is enforced by `scripts/ci/check-deploy-lint-parity.ts`. Override label: `ci-config-change`.

## CONDITIONAL-GO sub-decision B (TWO-SURFACE) — PR-time worker + verifier compile gates (NON-REQUIRED)

- Root tsconfigs exclude `services/`, worker CI was eslint + vitest only, and `packages/verifier` built only on `sdk-v*` tags — so CI **never compiled** the worker or verifier source with `tsc`. A worker/verifier TS error could pass every PR check and only surface in the Dockerfile build at deploy time (the deploy-typecheck blackout class, `memory/project_deploy_typecheck_blackout.md`).
- `ci.yml` gained two jobs:
  - **`Worker Build (deploy-parity)`** (job `worker-build-parity`): `services/worker` → `npm ci --ignore-scripts` then `npm run build` (the EXACT Dockerfile build = `tsc -p tsconfig.build.json`). Node 20 (matches Dockerfile), `cache: npm` keyed on `services/worker/package-lock.json`. Build step name carries the `deploy-parity` marker that `check-deploy-build-parity.ts` keys on.
  - **`Verifier Build`** (job `verifier-build`): `packages/verifier` → `npm ci` then `npm run typecheck` (tsc) + `npm run build` (tsup). `cache: npm` keyed on `packages/verifier/package-lock.json`.
  - Both use an **in-job path filter** (a `git diff --name-only origin/$BASE_REF...HEAD` step setting `changed`) guarding the install/build steps; the job ALWAYS runs and ALWAYS posts a green/red result (a `Skip notice` step on no-match). This mirrors the E2E / ai-eval-gate pattern so a future required-flip can't strand a non-matching PR in Mergify on an absent check.
- 3-way anti-drift guard: `scripts/ci/check-deploy-build-parity.ts` (in the `typecheck-lint` job) asserts package.json `scripts.build` ≡ Dockerfile `RUN npm run build` ≡ ci.yml worker compile step, fail-closed. Override labels: `ci-config-change` / `build-parity-ack`.
- **NON-REQUIRED for now** — these jobs are intentionally NOT in branch protection or `.mergify.yml merge_conditions`. They report status while the empirical RED list is gathered; the required-flip is admin-gated to Carson behind the CEO-gated quiet window. Do NOT add them to the required-check set or Mergify queue conditions without that approval.

## Container-image CVE scan gate (TVM/IVS) + break-glass

- `deploy-worker.yml` runs a Trivy base-image CVE scan (`build → scan → push → deploy`) that fails the deploy on FIXABLE HIGH/CRITICAL OS CVEs (`pkg-types: os`, `severity: HIGH,CRITICAL`, `ignore-unfixed: true`, `exit-code: '1'`). `pkg-types` is the current Trivy input (`vuln-type` is deprecated). Invariant guarded at PR time by `scripts/ci/check-image-scan-gate.ts` (wired into ci.yml as "Enforce container-image CVE scan gate (TVM/IVS)"); unit tests in `scripts/ci/check-image-scan-gate.test.ts`. No PR override label — security control, not style.
- **DB-fetch hardening** so a transient vuln-DB outage doesn't wedge deploys: `cache: true`, `github-token: ${{ secrets.GITHUB_TOKEN }}` (authenticated pulls), `TRIVY_DB_REPOSITORY` + `TRIVY_JAVA_DB_REPOSITORY` set to the `public.ecr.aws/aquasecurity/*` mirror (escapes the shared ghcr.io `TOOMANYREQUESTS` pool), and `timeout-minutes: 10` (fail fast on a hung fetch).
- **Operator break-glass** for a hard scanner-infra outage: `workflow_dispatch` boolean input `bypass_image_scan` (default false). When an operator manually dispatches a deploy with it set, the scan step is skipped via `if: github.event.inputs.bypass_image_scan != 'true'` and an "Audit image-scan bypass (break-glass)" step echoes `⚠️ image scan bypassed by ${{ github.actor }}` + run URL. It skips ONLY the scan step — the deploy still runs. This is a RUNTIME escape for a wedged scanner, distinct from a PR-time gate-weakening label: the scan-gate guard's severity/fixable/pinning/`pkg-types`/break-glass assertions remain non-overridable. `check-image-scan-gate.ts` asserts the break-glass is both wired (boolean input + guarded scan step) and audited (logged with the actor).

## R0 anti-false-done CI jobs (SCRUM-1246 wave)

| Job | Script | Override label |
|---|---|---|
| `coverage-monotonic` | `scripts/ci/check-coverage-monotonic.ts` | `coverage-drop-allowed` + `Linked Jira: SCRUM-NNNN` in body |
| `handoff-claims` | `scripts/ci/check-handoff-claims.ts` | `handoff-narrative-only` |
| `feedback-rules` | `scripts/ci/check-feedback-rules.ts` (orchestrator) | per-rule label (see `memory/README.md`) |
| `count-exact-baseline` | `scripts/ci/check-count-exact-baseline.ts` | `count-exact-allowed` |
| `sonar-quality-gate-config` | `scripts/ci/check-sonar-quality-gate.ts` | none; fix SonarCloud Quality Gate / New Code Definition (SCRUM-1681) |

Continue-on-error remaining (3 of 6 stripped in R0-2): RLS tests, E2E tests, Lighthouse, Generated Types Check. Each carries an inline `SCRUM-1248` annotation pointing at the follow-up sub-story (SCRUM-1301/1302/1303/1309) that must close before strip.

## S0-E4 release-pipeline additions (2026-06-17)

- `ci.yml` gained three steps: "Audit local migration ledger integrity (SCRUM-2500)" + "Block migration agents.md collisions (S0-E4)" (first lint job) and "Tiered-merge authority (S0-E4)" (policy-lints, advisory).
- `migration-drift.yml` gained "Full-ledger numeric-integrity audit (SCRUM-2500 / S0-4.2)" — runs `check-ledger-numeric-integrity.ts` over the prod ledger payload the drift step already fetches (read-only; reuses the same token; skipped only when the fetch didn't run, e.g. Dependabot). Closes the gap that let the 2026-06-15 timestamp re-regression pass unseen.

## E2E worker health-wait widened (2026-07-12)

- `ci.yml` "Start worker for E2E tests": health-check budget 60s → 120s (tsx cold-compiles the worker on first boot; observed healthy boots in the #1439/#1443 runs took ~10s, but the margin was thin for cold npm caches). The gate remains hard-fail (`exit 1` + worker-log dump) — specs never run against a dead worker; only the false-negative window shrank. Shipped alongside the `e2e/api-keys.spec.ts:166` strict-mode fix (see `e2e/agents.md` 2026-07-12).

## S3.3 trusted-main Worker TSX cwd contract (2026-07-15)

- Worker TypeScript CLIs launched from repository-root workflow steps with `npm --prefix services/worker exec -- tsx` must pass a repository-root-valid `services/worker/src/...` target. A bare `src/...` target resolves against the repository root and fails before the CLI loads. `scripts/ci/s33-wave1-github-evidence.test.ts` pins the exact four prerequisite and one acceptance targets so this cannot silently recur.

## S3.3 Wave-2 trusted-main corpus acceptance (2026-07-15)

- `s33-wave2-batch-acceptance.yml` runs inert candidate preflight on
  `pull_request_target`, accepts a CTO Ed25519 envelope delivered by either an
  issue comment or formal review, publishes an exact-head commit status only
  after preserving the verified artifact, then re-verifies and consumes the
  identical packet on the merged-main commit. GitHub state/login is transport
  evidence, never acceptance authority. The workflow-level token has no
  permissions; each job declares its own read scope, and status write exists
  only on the two jobs that publish those exact success statuses.
- The evaluator is materialized from an exact base commit proven to be an
  ancestor of the live `main` tip, then its dependencies are installed in
  `trusted/` before candidate data is fetched. Privileged jobs do not invoke
  `actions/checkout`; candidate Git objects live only in an inert bare
  repository under `RUNNER_TEMP`, with no candidate checkout, cache, import,
  test, package install, or working directory.
  Mergify routes every corpus-touching PR (including mixed-path PRs) to the
  single-item `s33-wave2-corpus` queue and requires the authenticated exact-head
  status; ordinary and hotfix queues explicitly exclude those paths.

## Deploy Worker full-history preflight parity (2026-07-15)

- The `pre-deploy-checks` checkout in `deploy-worker.yml` must use
  `fetch-depth: 0`. S3.3 worker acceptance tests verify immutable commit
  ancestry and cannot run correctly from the default shallow checkout.
- `scripts/ci/deploy-worker-history-contract.test.ts` pins this ordering before
  `npm test`. The staging-tier classifier treats only an additive full-history
  checkout change as T0; removing it or choosing a shallow depth fails closed.

## 2026-07-28 — agents.md append-only gate (union-drop backstop)

`ci.yml` `dependency-scan` gained **Block dropped agents.md content
(append-only)** (`scripts/ci/check-agents-md-append-only.ts`). It must stay in a
job with `fetch-depth: 0` — it resolves `merge-base(BASE_REF_SHA, HEAD)`, which
a shallow checkout cannot reach. `dependency-scan` already pins full history for
`ciContext.ts` (see the SCRUM-1246 comment on its checkout step); do not move
this step into a shallow job.

`BASE_REF_SHA` comes from `github.event.pull_request.base.sha`, so on
push-to-main runs it is empty and the gate skips rather than failing.
## `pull_request` `types:` contract (SCRUM-3029/3030, 2026-07-28)

- GitHub's default `types:` for a bare `pull_request:` trigger is
  `[opened, synchronize, reopened]`. `synchronize` fires only on a new
  commit — a **body-only edit** (bumping a head-SHA reference after a soak,
  updating a `## Staging Soak Evidence` block, adding an approver note)
  never re-fires the workflow unless `edited` is explicitly listed. A
  workflow gating merge-relevant evidence (migration drift, staging
  evidence, anything a PR body can update without a new commit) that omits
  `edited` will keep showing a stale run as current — `gh pr checks` cannot
  tell the difference. See
  `docs/runbooks/ci/verifying-current-check-runs.md` for the full failure
  mode and the cross-check procedure via
  `gh api repos/{owner}/{repo}/commits/<head-sha>/check-runs`.
- `migration-drift.yml` was fixed under SCRUM-3029: `on.pull_request.types`
  is now `[opened, synchronize, reopened, edited]`. The job is a read-only
  script + one Supabase Management API call (well under a minute), so
  re-running on every body edit is cheap; the existing
  `concurrency: { group: migration-drift-${{ github.ref }}, cancel-in-progress: true }`
  already coalesces back-to-back edits on the same PR (pull_request
  `github.ref` is PR-scoped, `refs/pull/<n>/merge`) — no additional
  concurrency change was needed.
- When adding or reviewing a new `pull_request`-triggered workflow: if the
  gate can be satisfied or invalidated by a PR **body** change alone (any
  evidence-block / head-SHA-reference / approval-note workflow), add
  `edited` to `types:` unless the job is expensive enough that re-running it
  on every body edit is a real cost — in that case, document the tradeoff
  inline in the workflow (why `edited` is omitted) rather than leaving it
  silently absent.

## Related

- `docs/runbooks/migration-drift-playbook.md` — operator runbook for when the drift check fails
- `docs/runbooks/ci/verifying-current-check-runs.md` — cross-checking `gh pr checks` against actual check-run timestamps; the frozen-event-payload rerun trap and its fix (SCRUM-3030)
- S0-4.3 stacked-PR + tiered-merge playbook (drafted Mergify/branch-protection diff for Carson) → Google Doc "ARKOVA PI-1 S0-E4 — Mergify / Stacked-PR + Tiered-Merge Playbook" (Drive ARKOVA PI-1-S0): https://docs.google.com/document/d/1iontJPUkhLQkQyZG4PETGuPj3kf23Kgn-1kDxqukfr8/edit
- `docs/confluence/16_migration_drift_prevention.md` — ADR for Option A (read-only diff)
