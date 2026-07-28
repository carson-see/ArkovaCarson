# .github/workflows/ — CI/CD Workflows

## Files

| File | Purpose | Jira |
|------|---------|------|
| `ci.yml` | Secret scan, dependency audit, TDD enforcement, typecheck, lint, coverage-monotonic, handoff-claims, feedback-rules, count:'exact'-baseline | SCRUM-1248/1249/1252/1253/1254 |
| `deploy-worker.yml` | Cloud Run worker deployment. Worker lint uses `npm run lint` (matches CI). | SCRUM-1250 |
| `migration-drift.yml` | Read-only diff: local migrations vs prod applied set. Prevents the scorecard-outage class of bug. | SCRUM-908 |
| `revision-drift.yml` | 10-min cron — fetch worker `/health.git_sha`, compare to `git rev-parse origin/main`, fire Sentry on drift > 1h or `missing-sha`. | SCRUM-1247 |

`staging-evidence.yml` passes both `BASE_REF_SHA` and `HEAD_REF_SHA` into `scripts/ci/check-staging-evidence.ts`; the gate compares those SHAs against the PR-body evidence. Exact PR head SHA must always match. Base SHA movement is impact-assessed: T0 docs/tests/CI/tooling-only drift can preserve soak evidence with an approved `Base drift impact:` note, while runtime/schema/staging/deploy drift still fails closed.

**SCRUM-3026 (2026-07-28) — live PR state, not the frozen event payload.** A `Resolve live PR state` step (`id: live_pr`) runs `gh api repos/.../pulls/<N>` at the START of every job execution and resolves the PR's CURRENT head SHA, base SHA, merge-preview SHA, and body — never `github.sha` / `github.event.pull_request.*` directly, which are frozen at the moment the triggering webhook was delivered and replay stale on a bare rerun (GitHub UI "Re-run jobs", `gh run rerun`, a re-request, or a Mergify re-check without a new delivery). Checkout pins `ref: ${{ steps.live_pr.outputs.checkout_sha }}` (the live-resolved merge-preview SHA, falling back to the branch head SHA if GitHub hasn't finished computing `merge_commit_sha`); the evidence-check step's `PR_BODY` / `HEAD_REF_SHA` / `BASE_REF_SHA` bind to that same step's outputs. `scripts/ci/staging-evidence-workflow-contract.test.ts` pins this shape and rejects any regression back to a raw `github.sha` / `github.event.pull_request.*` binding. `scripts/ci/mint-fresh-event.sh` is the sanctioned helper for forcing a genuinely fresh webhook event (tree-identical empty commit + push) when a live re-read of the existing event isn't enough — see `docs/runbooks/ci/mint-fresh-event.md`.

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

## Deploy-worker pause gate (`vars.DEPLOY_WORKER_PAUSED`, 2026-08 launch wave)

`deploy-worker.yml` auto-deploys to prod Cloud Run on every push to `main`
touching `services/worker/**`. During the 2026-08 wave-merge window
(`docs/release/wave-merge-choreography-2026-08.md`) T2/T3 worker + migration
PRs are deliberately merged BEFORE the 72h soak (CTO ruling 2026-07-28) —
left ungated, every one of those merges would auto-deploy unsoaked chain/
billing/migration code straight to prod. `.github/workflows/deploy-worker.yml`
now has a `deploy-gate` job between `pre-deploy-checks` and `deploy`:

- **`vars.DEPLOY_WORKER_PAUSED`** — a repository Actions **variable** (not a
  secret; Settings -> Secrets and variables -> Actions -> Variables). Default
  (unset, or anything other than the literal string `"true"`) is **unpaused**
  — fail-open to normal auto-deploy, so nobody has to remember to unpause
  after routine work.
- Gates ONLY the `deploy` job (image build/scan/push, canary deploy, smoke
  test, promote-to-full, health verify). `pre-deploy-checks`
  (typecheck/lint/zk-artifacts/`npm test`/copy-lint) is unconditional and
  always runs on every push — quality gates never go dark, paused or not.
- When paused, the `deploy-gate` job's "Evaluate DEPLOY_WORKER_PAUSED" step
  emits a `::warning::` annotation AND a `$GITHUB_STEP_SUMMARY` banner on
  **every** push-triggered run, naming the commit, the reason, and both the
  override and reversal procedures — a paused deploy is loud, not a silent
  skip nobody notices.
- **`workflow_dispatch`** (Actions tab -> Deploy Worker -> Run workflow, or
  `gh workflow run deploy-worker.yml`) ALWAYS bypasses the pause — a human
  explicitly dispatching this workflow is by definition an intentional
  deploy. This is the one and only override path; there is no PR label or
  env var that also bypasses it (keeps the escape hatch to a single,
  auditable, human-initiated action).
- **Reversal:** `gh variable set DEPLOY_WORKER_PAUSED --body false` or
  `gh variable delete DEPLOY_WORKER_PAUSED` — takes effect on the next push,
  no code change / PR / redeploy of this workflow required.
- **`if:` semantics note** (repo just got bitten by a related class of bug —
  keep this precise): `deploy` declares an explicit
  `if: needs.deploy-gate.result == 'success' && needs.deploy-gate.outputs.proceed == 'true'`
  rather than relying on the implicit default `if: success()`. A bare
  `success()` on a job only inspects its OWN direct `needs:` — fine here
  since `deploy` needs only `deploy-gate` — but an explicit boolean
  expression on a job-level `if:` is evaluated regardless of the needed
  job's outcome unless `result == 'success'` is spelled out; without that
  clause a crashed `deploy-gate` (empty `outputs.proceed`) would still
  correctly evaluate false (`'' == 'true'` is false) but a future edit that
  reuses this pattern must keep the `result == 'success'` guard explicit
  rather than assuming the default applies. Both `deploy-gate`'s own step
  (`id: check`) and `deploy`'s job-level `if:` were checked against
  `actionlint` (`brew install actionlint`) — zero findings.
- **Tier:** the change to `deploy-worker.yml` itself is classified **T2**
  by `scripts/ci/check-staging-evidence.ts`'s own `PATH_RULES` (`worker
  deploy config: prod runtime`) — the file's only T0 exemption is a
  Dependabot `uses:`-only bump (`isDeployWorkerUsesOnlyBump`), which this
  change does not qualify for (it adds a real job + `if:`/`env:`/`run:`
  content, not a version-pin or checkout-hardening line). The PR carrying
  this change declares `Tier: T2` honestly rather than self-declaring a
  lower tier to dodge the gate — see the PR body's residual-risk note for
  why the mechanical T2 classification does not match this diff's actual
  blast radius (it changes deploy ORCHESTRATION only: no secret, env var,
  image, region, scaling, or IAM line is touched, and the default state is
  unpaused/unchanged behavior).
## `$GITHUB_OUTPUT` heredoc delimiters must be per-run random (2026-07-28)

Any step that frames **author-controlled** text inside a `$GITHUB_OUTPUT` (or
`$GITHUB_ENV`) heredoc MUST use a per-run random delimiter, never a fixed
literal:

```bash
DELIM="ghadelim_$(openssl rand -hex 16)"
{
  echo "key<<${DELIM}"
  echo "$VALUE"
  echo "${DELIM}"
} >> "$GITHUB_OUTPUT"
```

**Why.** A fixed, guessable delimiter (`EOF`, or any constant) lets an author
put that exact string on its own line inside the content being framed. That
terminates the heredoc early, and everything after it is parsed as literal
`key=value` lines appended to `$GITHUB_OUTPUT` — including a forged duplicate
of the key being written. GitHub Actions resolves a duplicate output name to
its **LAST** occurrence, so the forgery wins. This is GitHub's own documented
remedy for the class.

Fixed instances:

- `staging-evidence.yml` "Resolve live PR state" — the PR-body heredoc
  (`STAGING_EVIDENCE_PR_BODY_EOF` → `BODY_DELIM`), PR #1724.
- `ci.yml` "Aggregate commit messages" (`id: commits`) — the commit-message
  heredoc (`EOF` → `MSGS_DELIM`). The `msgs` output feeds `PR_COMMITS_MSGS`
  into two governance gates in the same job (`check-handoff-claims.ts` and
  `check-confluence-coverage.ts`), so a forged payload let a PR author steer
  what those gates believed the PR's commit history said. Verified
  empirically: with the fixed delimiter a crafted commit message replaced
  `msgs` wholesale; with the random one the same payload stays inert text
  inside the real message.

Both are pinned by contract tests that assert the delimiter is a
runtime-derived shell variable assigned from a command substitution, and that
the closing line reuses the same variable — plus mutation tests that revert to
a fixed literal and expect a throw. See
`scripts/ci/staging-evidence-workflow-contract.test.ts` and
`scripts/ci/ci-workflow-contract.test.ts`.

Out of scope: plain shell heredocs that feed a **static, repo-authored** script
into a program (e.g. `node <<'NODE'` in the golden-audit summary step). Those
frame no author-controlled value and write no key/value file.

## Related

- `docs/runbooks/migration-drift-playbook.md` — operator runbook for when the drift check fails
- `docs/runbooks/ci/verifying-current-check-runs.md` — cross-checking `gh pr checks` against actual check-run timestamps; the frozen-event-payload rerun trap and its fix (SCRUM-3030)
- S0-4.3 stacked-PR + tiered-merge playbook (drafted Mergify/branch-protection diff for Carson) → Google Doc "ARKOVA PI-1 S0-E4 — Mergify / Stacked-PR + Tiered-Merge Playbook" (Drive ARKOVA PI-1-S0): https://docs.google.com/document/d/1iontJPUkhLQkQyZG4PETGuPj3kf23Kgn-1kDxqukfr8/edit
- `docs/confluence/16_migration_drift_prevention.md` — ADR for Option A (read-only diff)
