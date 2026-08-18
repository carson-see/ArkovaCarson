# .github/workflows/ — CI/CD Workflows

## 2026-08-17 — Orphaned Export Lint now gates the Mergify queue

`check-success = Orphaned Export Lint` was added to all three `.mergify.yml` queue rules' `merge_conditions` (s33-wave2-corpus, urgent, default). The `orphaned-export-lint` job (CTO ruling R14, fail-closed by design — `continue-on-error: false`) had run on every PR since 2026-07-28 but was never in `merge_conditions`, so it reported without blocking — the exact "new top-level job would not be in branch protection or those merge conditions, so it could go red while Mergify merged anyway" class this file already documents. Config-only; the lint script itself is untouched. This is DISTINCT from the CONDITIONAL-GO sub-decision B jobs (`Worker Build (deploy-parity)` / `Verifier Build`), which remain deliberately NON-REQUIRED pending Carson's required-flip — that ruling covers those two jobs only. Branch protection's required-check set is still a separate Carson/admin surface; only the in-repo Mergify layer changed. Contract test: `scripts/ci/mergify-orphaned-export-gate.test.ts`.
## 2026-08-18 — python-sdk-tests now gates the Mergify queue

`check-success = Python SDK Tests (packages/arkova-py)` was added to all three `.mergify.yml` queue rules' `merge_conditions` (s33-wave2-corpus, urgent, default), in the same PR that introduces the `python-sdk-tests` ci.yml job (BUG-2026-08-12-007). A new top-level job is not in branch protection or those merge conditions, so it could go red while Mergify merged anyway — the exact class this file already documents; landing the job without this wiring would have kept the arkova-py suite advisory-only. The job is deliberately UNCONDITIONAL (no job-level `if:`, no path filter — it runs on every PR run of ci.yml), so requiring it cannot deadlock non-SDK PRs on a never-reported check; an unreported check never satisfies `check-success`. Branch protection's required-check set is still a separate Carson/admin surface; only the in-repo Mergify layer changed. Contract test: `scripts/ci/mergify-python-sdk-gate.test.ts`.

## Files

All 16 workflows, with their real triggers. **Not everything here is PR-driven** —
four workflows can fire with no PR and no push to `main` (cron, tag push, or an
issue comment), so a change to one of those can take effect outside the PR cycle.

| File | Trigger | Purpose |
|------|---------|---------|
| `ci.yml` | `push` (main/staging/develop) + `pull_request` | The main gate. 24 jobs: secret-scan, dependency-scan (also hosts the agents.md append-only gate), sonatype-sca, policy-lints, orphaned-export-lint, tdd-enforcement, typecheck-lint, test, python-sdk-tests (queue-gated via .mergify.yml — see the 2026-08-18 note), ai-eval-gate, tla-verify, migration-check, e2e, lighthouse, sbom-generation, worker-build-parity, verifier-build, evidence-identity-report, anti-hollow-soak-report. |
| `staging-evidence.yml` | `pull_request` incl. **`edited`**/`labeled`/`unlabeled` | The `Staging Soak Evidence Gate` required check (CLAUDE.md §1.11/§1.12). `edited` matters: a body-only evidence update fires no `synchronize`. |
| `migration-drift.yml` | `push` main + `pull_request` incl. **`edited`** | Read-only diff of local migrations vs the prod applied set. Prevents the scorecard-outage class of bug. Also runs the full-ledger numeric-integrity audit (SCRUM-2500). |
| `merge-authority.yml` | `pull_request` (`opened`/`synchronize`/`reopened`/`ready_for_review`) | Single `compute` job — reuses `requiredTierFor` to emit the tier/merge-council marker. Fails closed. |
| `gitleaks.yml` | `pull_request` main + `push` main | Single `scan` job — secret scanning. |
| `deploy-worker.yml` | **`push` to `main`** filtered to `services/worker/**` + `workflow_dispatch` | Cloud Run worker deploy: `pre-deploy-checks` → `deploy-gate` (the `vars.DEPLOY_WORKER_PAUSED` pause) → `deploy`. Worker lint uses `npm run lint` (matches CI). |
| `deploy-staging.yml` | **`workflow_dispatch` only** | Manual staging deploy. Inputs: `pr_number`, `source_ref`, `service` (default `arkova-worker-staging`), `force_reason` (must start `SCRUM-NNNN:` to bypass the lease check). |
| `verify-worker-runtime.yml` | **`workflow_dispatch` only** | Single `verify` job — optional `pr_number` input for authenticated staging-tag health. |
| `revision-drift.yml` | **`schedule` — cron `*/10 * * * *`** + `workflow_dispatch` | Every 10 min: fetch worker `/health.git_sha`, compare to `origin/main`, fire Sentry on drift > 1h or `missing-sha`. Runs with no PR involved. |
| `sonatype-scan.yml` | `pull_request` main (path-filtered to `**/package.json`, `**/package-lock.json`) + **`schedule` — cron `0 12 * * 1` (weekly, Mondays)** | `sonatype-oss-index` dependency scan. The weekly run fires with no PR. |
| `publish-sdk.yml` | **`push` of tags `sdk-v*`** + `workflow_dispatch` | Publishes the TypeScript SDK. Tag push only — never on a normal branch push. |
| `publish-python-sdk.yml` | **`push` of tags `arkova-py-v*`** + `workflow_dispatch` | Publishes `arkova-py`. Tag push only. |
| `pe-eval.yml` | **`workflow_dispatch` only** | Professional-education eval harness. Required inputs: `gates` (comma-separated gate IDs) + `endpoint` (Vertex tuned-model resource for `GEMINI_TUNED_MODEL`). |
| `s33-wave1-prerequisites.yml` | **`workflow_dispatch` only** | `build-prerequisites` — S3.3 Wave-1 corpus prerequisites. |
| `s33-wave1-acceptance.yml` | `pull_request` (path-filtered to the Wave-1 authorities/evidence files) + `workflow_dispatch` | `premerge-api-preflight` + `authenticate-wave1`. |
| `s33-wave2-batch-acceptance.yml` | **`pull_request_target`** + `pull_request_review` + **`issue_comment`** + `pull_request` (`closed`) | S3.3 Wave-2 trusted-main corpus acceptance. Privileged: `pull_request_target` and `issue_comment` run with repo-write context against **untrusted PR content** — see the hardening notes below before editing. Jobs: `candidate-preflight`, `exact-head-acceptance`, `consume-trusted-main`. |

`staging-evidence.yml` passes both `BASE_REF_SHA` and `HEAD_REF_SHA` into `scripts/ci/check-staging-evidence.ts`; the gate compares those SHAs against the PR-body evidence. Exact PR head SHA must always match. Base SHA movement is impact-assessed: T0 docs/tests/CI/tooling-only drift can preserve soak evidence with an approved `Base drift impact:` note, while runtime/schema/staging/deploy drift still fails closed.

**SCRUM-3026 (2026-07-28) — live PR state, not the frozen event payload.** A `Resolve live PR state` step (`id: live_pr`) runs `gh api repos/.../pulls/<N>` at the START of every job execution and resolves the PR's CURRENT head SHA, base SHA, merge-preview SHA, and body — never `github.sha` / `github.event.pull_request.*` directly, which are frozen at the moment the triggering webhook was delivered and replay stale on a bare rerun (GitHub UI "Re-run jobs", `gh run rerun`, a re-request, or a Mergify re-check without a new delivery). Checkout pins `ref: ${{ steps.live_pr.outputs.checkout_sha }}` (the live-resolved merge-preview SHA, falling back to the branch head SHA if GitHub hasn't finished computing `merge_commit_sha`); the evidence-check step's `PR_BODY` / `HEAD_REF_SHA` / `BASE_REF_SHA` bind to that same step's outputs. `scripts/ci/staging-evidence-workflow-contract.test.ts` pins this shape and rejects any regression back to a raw `github.sha` / `github.event.pull_request.*` binding. `scripts/ci/mint-fresh-event.sh` is the sanctioned helper for forcing a genuinely fresh webhook event (tree-identical empty commit + push) when a live re-read of the existing event isn't enough — see `docs/runbooks/ci/mint-fresh-event.md`.

The root `typecheck-lint` job also runs `npm run lint:batch-drain-evidence`. Keep that focused command current when a batch-drain evidence, admission, crash, observation, or shared time/parser file is added; local-only lint is not an enforceable gate.

## SCRUM-1068 — Sonatype SCA

- `ci.yml` includes a non-blocking `sonatype-sca` PR job for the first sprint.
- The local GPL/AGPL/LGPL/SSPL deny-list is always enforced with `npm run security:license-denylist`; legacy `snarkjs` GPL transitive packages and `libheif-js` (LGPL-3.0 — **shipped today** via the `heic-decode` production dependency, not "pending PR #1740" as this line previously claimed; corrected 2026-08-01) are documented in `scripts/security/license-denylist.allowlist.json`. 2026-07-28 (engineering-counsel review): the pattern was blind to `LGPL-*` strings (word-boundary bug — see `scripts/security/agents.md`) and newly flags `@img/sharp-libvips-*` (LGPL-3.0-or-later, transitive via `@huggingface/transformers` → `sharp`) on `main` with no allowlist entry yet — this gate is expected to be RED until that's triaged.
- Sonatype Lifecycle remote evaluation runs only when `SONATYPE_LIFECYCLE_URL`, `SONATYPE_LIFECYCLE_USERNAME`, `SONATYPE_LIFECYCLE_PASSWORD`, and `SONATYPE_LIFECYCLE_APPLICATION_ID` secrets exist.

## Patterns

- Workflows use pinned action SHAs (not `@v4` tags) for supply-chain safety.
- External downloads MUST verify SHA256. See ci.yml's `Verify vendored tla2tools.jar` step for the canonical pattern (SCRUM-1248 / R0-2); when the upstream release binary changes, refresh the pin with a local `curl -fsSL <release-url> | shasum -a 256` check and update the inline date.
- **`tla2tools.jar` is no longer downloaded — it is vendored at `vendor/tla/tla2tools.jar`** (2026-08-11). Upstream `tlaplus/tlaplus` v1.8.0 is a MUTABLE pre-release tag that was re-cut four times in ~5 weeks (2026-07-09, 07-18/21, 07-31, 08-11). Each re-cut broke the download-time pin, reddened `TLA+ Verification` on every `machines/` PR, and **skipped the model check** — verification silently stopped running while the job read as an infra hiccup. Provenance, the three-anchor update protocol, and the rejected alternatives (v1.7.4 downgrade, GCS mirror) are in `vendor/tla/agents.md`.
- Do NOT reintroduce `tla-precheck setup` into the TLA job. It exists to download the jar, and it populates the `~/.tla-precheck` cache that `resolveTlcJarPath()` silently falls back to when `TLA2TOOLS_JAR` is unset or points at a missing file — turning a misconfiguration into a green run against the wrong TLC build instead of a loud failure.
- A gate's own configuration belongs in its trigger set. `.github/workflows/ci.yml` and `vendor/tla/**` are in the `TLA+ Verification` path filter precisely so a change to the checker, its integrity check, or the step that runs it re-runs the job that consumes it. Before 2026-08-11 they were not, so none of the four re-pins was ever exercised by its own PR.
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

`BASE_REF_SHA` comes from `github.event.pull_request.base.sha`, so it is empty
on push events. The gate then skips on `GITHUB_EVENT_NAME != 'pull_request'`
rather than falling back to `origin/main`. That fallback matters: this job also
runs on push to `staging` and `develop` (see `on.push.branches`), where
`merge-base(origin/main, HEAD)` is a real but unrelated ancestor, so the gate
would diff a diverged branch against main and fail on history the push never
touched. Only a PR has a meaningful "theirs" side. With no `GITHUB_EVENT_NAME`
at all (local runs) it still defaults to `origin/main`, which is what you want
from a developer shell.

The job needs `pull-requests: read` for the live label fetch behind the
`agents-md-deletion-approved` override; without it the override silently
reverts to frozen-payload-only behavior and stops working on re-runs.
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

## Compliance-mapping mirror gate (2026-08-01, SCRUM-2283)

`ci.yml` → `typecheck-lint` job gains `npm run ci:compliance-mapping-mirror`
(`scripts/ci/check-compliance-mapping-mirror.ts`).

Asserts the two `EMITTABLE_CONTROL_IDS` sets — `src/lib/complianceMapping.ts` and
`services/worker/src/utils/complianceMapping.ts` — are identical in both directions.

**Why it is a CI gate and not a code review item:** the worker file is a hand-maintained
mirror ("control IDs must match" per its own header) and **two** separate remediations each
fixed the frontend only. `DPF-NOTICE` / `DPF-ACCOUNTABILITY` were pulled from the frontend on
2026-07-10 after the PO confirmed on 2026-06-05 that Arkova holds no EU-US DPF certification,
and the worker kept writing them onto every SECURED anchor and serving them from
`/api/v1/verify`, the audit export, and the GRC push to Vanta/Drata/Anecdotes until
2026-08-01. Review did not catch it twice; a gate does.

**Do not add an override label.** The failure mode this prevents is a false external-status
claim (R-7 / CLAUDE.md §1.5), and the fix is always a one-line removal from the worker
catalogue — never a re-add to the frontend, which would re-assert the retired claim.
## Deploy-worker traffic safety: the clear step must be `--no-traffic` (2026-08-01)

**The service is permanently pinned `--to-latest`.** `Promote canary to full
traffic` runs `gcloud run services update-traffic --to-latest`, and that is a
persistent *service* setting, not a one-shot for that deploy. Consequence:
**any** `gcloud run services update` on this service creates a revision that
immediately takes 100% of production traffic.

`Clear conflicting env/secret types` is exactly such a command. It exists for a
real reason — a name that currently exists as one type (env var vs secret)
cannot be re-declared as the other in the same `gcloud run deploy`, so the
canary deploy needs them cleared first — but without `--no-traffic` it briefly
moves prod onto a revision with `CRON_SECRET` + the four DocuSign names
stripped. Observed live on 2026-08-01: prod on `arkova-worker-00892-jd2` with
50 env vars against the canary's 57, DocuSign Connect webhook answering 503
`integration_disabled`. It self-heals on promote, which is why it went
unnoticed — but any failure between the clear and the promote (canary deploy,
smoke test, a cancelled run) strands prod DocuSign-blind indefinitely, and
nothing alarms on it.

Three things now hold that line, and all three must stay:

1. `--no-traffic` on the clear step. The cleared revision is created but never
   served; traffic stays on the last good revision until the promote step moves
   it deliberately. A failure in between now leaves prod on fully-configured
   code — the correct direction to fail.
2. `scripts/ci/deploy-worker-history-contract.test.ts` → `Deploy Worker
   traffic-safety contract` pins the SHAPE: the clear step is `--no-traffic`,
   the canary is `--no-traffic`, `update-traffic` appears exactly once and after
   the smoke test, and **every name the clear step removes is re-set by the
   canary deploy** (so a future `--remove-*` addition cannot become a permanent
   strip).
3. `Verify serving revision carries required config` pins the OUTCOME at
   runtime — it reads the revision actually taking traffic and fails the job if
   any required name is absent. It runs after the promote, so it is an alarm
   rather than a gate; the point is that a stripped prod can never again be
   invisible. It also covers a hand-run `gcloud run services update`, which no
   static test can see.

**The clear step is non-fatal but must never be silent (PR #1823 review).** It
tolerates a non-zero exit deliberately — clearing a name that is not currently
set is a no-op, not an error. But it must NOT redirect stderr to `/dev/null`:
doing so made a genuine rejection (unsupported flag, missing IAM, wrong service
name) indistinguishable from "nothing to clear", and the only downstream symptom
was the canary deploy failing later with an apparently-unrelated env/secret type
conflict. The step now captures combined output, prints it, and emits a
`::warning::` on a non-zero exit; a contract case (`never swallows the clear step
failure into silence`) pins that, asserting against the step's executable lines
only so it grades behaviour rather than the comment that names the old form.

**`ENABLE_CONNECTOR_ARTIFACT_DRAIN` lives in this file's `--set-env-vars`, and
only here.** It is env-only (`services/worker/src/config.ts` reads
`process.env` — there is no `switchboard_flags` row), and `--set-env-vars` is
exhaustive, so a manual `gcloud run services update` to set it is wiped by the
next deploy. Per `docs/release/prod-enablement-checklist-2026-08.md` §2.3 the
order was DRAIN first → observe one clean `/jobs/drain-connector-artifacts`
cron cycle → **then** decide on `ENABLE_CONNECTOR_ARTIFACT_ENQUEUE`; that gate
has since been passed, and both flags now ship in `--set-env-vars`. The
contract test (`never enables the connector-artifact producer without its
consumer`) therefore pins the surviving invariant rather than the one-time
ordering: **if** `ENABLE_CONNECTOR_ARTIFACT_ENQUEUE=true` appears in this
workflow, the canary step must also carry
`ENABLE_CONNECTOR_ARTIFACT_DRAIN=true` — a producer without its consumer piles
up `pending` `connector_artifact` rows with nothing draining them.

## Drive connector flag activation (2026-08-03, GH #1835/#1836/#1837)

PR #1944 (merged) fixed three Drive-connector code defects — channel-token secret
(was the org UUID), the lease-guarded renewal job, `folder_path` population — but
left the connector fully dark: `ENABLE_DRIVE_OAUTH`, `ENABLE_DRIVE_WEBHOOK`,
`ENABLE_DRIVE_CHANGES_RUNNER` were never added to this file's `--set-env-vars`, so
nobody could connect, no webhook push could land, and no landed push would be
processed. This PR flips all three `true` in the canary deploy step, after
re-verifying directly against the merged code (not assumed from a prior claim):
the create-then-stop channel-renewal ordering fix is real
(`integrations/connectors/drive-subscription-renewal.ts`), `WORKER_PUBLIC_URL` was
already in this file's `--set-env-vars`, and the run-lease guard
(`DRIVE_SUBSCRIPTION_RENEWAL_RUN_LEASE`, `jobs/run-lease.ts`) really is shared by
both the Cloud Scheduler HTTP route (`routes/cron.ts`) and the in-process backup
(`routes/scheduled.ts`) via the one `runDriveSubscriptionRenewal()` entry point —
so the two triggers cannot double-fire. Boot-time config validation for
`ENABLE_DRIVE_OAUTH=true` in production (`config.ts`) requires
`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
`INTEGRATION_STATE_HMAC_SECRET` (all three already in this file's `--set-secrets`)
and `GCP_KMS_INTEGRATION_TOKEN_KEY` (already in `--set-env-vars`) — verified
present so the flag flip cannot crash-loop the worker at boot.

**`ENABLE_WORKSPACE_RENEWAL` was deliberately NOT added**, despite being named
alongside the other three in `flagRegistry.ts` and in a Drive-flavored doc comment
in `config.ts`. It does not gate `runDriveSubscriptionRenewal()` (that job is
unconditional, protected only by the run lease above) — it gates a different,
unrelated job (`workspace-subscription-renewal.ts`, SCRUM-1147) whose
`driveRenew`/`graphRenew` deps are hardcoded stubs that always throw "not
configured," with no Cloud Scheduler trigger anywhere in this repo. Setting it
would not activate anything Drive-related.

**This PR does not fully activate the connector by itself.** The renewal job's
Cloud Scheduler job (`drive-subscription-renewal`, declared in
`scripts/gcp-setup/cloud-scheduler.sh`) is still not applied to prod — that is a
separate, manual `gcloud scheduler jobs create` step outside this workflow's
reach (no `gcloud` credentials in the authoring session). Until it runs, renewal
relies solely on the hourly in-process backup, which is not a reliable substitute
under Cloud Run CPU throttling (node-cron does not fire on a throttled instance).
See the activating PR's body for the exact command and a post-deploy verification
runbook.

## Edge worker suite wired into `Tests` (2026-08-15)

`services/edge/vitest.config.ts` had existed since 2026-06-05 and **no CI job ever ran it**. The
only edge step in `ci.yml` was `TypeScript check (edge workers)` in `typecheck-lint` — `tsc
--noEmit`, which compiles the tests but never executes them. The root `Tests` job could not collect
them either: root `vitest.config.ts` globs `tests/**`, `src/**`, `scripts/**` from the repo root,
and `services/edge/` matches none of those. So `services/edge/src/mcp-tools.test.ts` (36 assertions)
was a suite that ran nowhere and blocked nothing.

Added to the **`test` job** (`Tests`), after "Run worker tests with coverage":

- `Install edge dependencies` (id `edge-deps`) — `npm ci --ignore-scripts` in `services/edge`, with
  the same 3-attempt retry loop as `Install worker dependencies`. `services/edge` carries its own
  `package-lock.json` and is not in the root workspace, so this install is mandatory.
- `Run edge worker tests` (id `edge-tests`) — `npm test`, gated on `edge-deps` succeeding.
- Both ids added to the `Aggregate test suite results` map **and** its iteration list, and
  `services/edge/package-lock.json` added to the job's `cache-dependency-path`.

**Why a step here and not a new job.** `Tests` is already a required status check and appears as
`check-success = Tests` in `.mergify.yml` five times. A new top-level job would not be in branch
protection or those merge conditions, so it could go red while Mergify merged anyway — reproducing
the very bug this fixes. Adding a *new required check* is a branch-protection change (Carson/admin),
not something a PR can do to itself.

Follows the job's existing `if: always()` convention — see the long comment above "Run tests with
coverage" for why (the 2026 silent-skip bug where a single early failure skipped the whole worker
suite with no signal). Baseline at wiring time: **36/36 green**, verified locally on `main` before
the gate was added — a gate must not be merged red.

## Related

- `docs/runbooks/migration-drift-playbook.md` — operator runbook for when the drift check fails
- `docs/runbooks/ci/verifying-current-check-runs.md` — cross-checking `gh pr checks` against actual check-run timestamps; the frozen-event-payload rerun trap and its fix (SCRUM-3030)
- S0-4.3 stacked-PR + tiered-merge playbook (drafted Mergify/branch-protection diff for Carson) → Google Doc "ARKOVA PI-1 S0-E4 — Mergify / Stacked-PR + Tiered-Merge Playbook" (Drive ARKOVA PI-1-S0): https://docs.google.com/document/d/1iontJPUkhLQkQyZG4PETGuPj3kf23Kgn-1kDxqukfr8/edit
- `docs/confluence/16_migration_drift_prevention.md` — ADR for Option A (read-only diff)
