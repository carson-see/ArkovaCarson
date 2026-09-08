# Gate dry run — `scripts/ci/check-staging-evidence.ts` against the five draft blocks

Run 2026-09-02T21:15Z–21:22Z from the agent worktree detached at origin/main `f825952001a2f436b575b62fa4d11946e76ff3eb` (the gate script graded is that commit's `scripts/ci/check-staging-evidence.ts`, 4278 lines; `scripts/ci/lib/ciContext.ts` from the same commit). Nothing was pushed, no PR was edited, no Supabase project or Cloud Run service was touched. Git use: reads (`merge-base`, `diff`, `rev-parse`, `rev-list`) and detached checkouts of already-fetched merge-preview commits inside the worktree, restored to origin/main afterwards.

Bypass state, read live: `gh variable get SOAK_GATE_DISABLED` → `false`; the compiled bypass expiry (`SOAK_GATE_BYPASS_EXPIRES_AT` = 2026-08-16T00:00:00Z) has also passed. The gate enforces in full.

Live PR state fed to the gate (`gh api repos/carson-see/ArkovaCarson/pulls/N`, 2026-09-02T20:4xZ):

| PR | head.sha | base.sha | merge_commit_sha (first parent) | draft | author |
|---|---|---|---|---|---|
| #2524 | e5815e9ac2549e70c648d5e1ff8a3d285e967731 | 4b3db0c0c4aaa28b1df5506c59357835f6f995a7 | e480b1166 (4b3db0c0c) | yes | carson-see |
| #2525 | 24fbb72cccbfe6ca929200ffa7a8d11d4ade8403 | 8147ed3a719c93112ddbfcee3889ec30bc26f4ec | 2ca24fda2 (0faa5bd5d) | yes | carson-see |
| #2526 | c646d18e8e27cc7bf290a3225ed3a80bf4718b3f | 19d7adfbdd48ba87d9980364c2699c73317dffd4 | 763eb5350 (0faa5bd5d) | yes | carson-see |
| #2527 | 2cb005850919d3af2fea443382ebc0d77f20851e | 4b3db0c0c4aaa28b1df5506c59357835f6f995a7 | 5589e468d (0faa5bd5d) | yes | carson-see |
| #2528 | 7781bf0eb67df38d576e28f038003d7e3210dbd3 | b5e823c3a2b43f0b6c6c329161c9d593a1462539 | 80aa3ae15 (b5e823c3) | **no** | carson-see |

Facts that differ from the brief: #2528 is not a draft; #2526's GitHub base.sha is 19d7adfb, not the 5c145df5 the manifest recorded (5c145df5 is the merge-base); the first parent of every RC merge preview predates the manifest commit 607cb8d70 (19:52Z).

## 1. How the gate takes its inputs (from the script and `.github/workflows/staging-evidence.yml`)

(a) **Inputs.** `main()` reads `PR_BODY` (the live body, resolved by the workflow with `gh api` — never the frozen event payload), `HEAD_REF_SHA` (live `.head.sha`), `BASE_REF_SHA` (live `.base.sha`, via `ciContext.getBaseRef`), `PR_NUMBER`, `PR_AUTHOR` (live `.user.login`), `DEPLOY_WORKER_PAUSED`, `SOAK_GATE_DISABLED`. Changed files = `git diff --name-only --diff-filter=AMR <diffBase>..HEAD` where, because `GITHUB_REF` is `refs/pull/N/merge` and HEAD is the checked-out merge preview, `diffBase` is `HEAD^1` (`ciContext.resolveDiffBase`, FD-GATE-2). The RC manifest is read from the checked-out tree (`docs/staging/rc-manifests/<path>`). There is no `--body` flag and no `GITHUB_EVENT_PATH` read; the unit tests call the exported `check({ body, files, headSha, baseSha, prNumber, prAuthor, nowMs, rcManifestLoader, diffProvider, ancestryProvider, … })` directly.

(b) **Required labels** (line-anchored, `- ` bullets / emphasis / `[x]` tolerated; label must match literally):
- T1: `Tier:`, `PR head SHA:`, `Staging tag URL or N/A explanation:`, `Health/smoke result:`, `Soak start:`, `Soak end:` (≥ 2 h), `CI/E2E green:` (must contain green/pass/success), `Rollback plan:`, `Risk rationale:`, `Human approver:` (value-checked: no placeholder, no `Claude`, no self-reference).
- T2: `Tier:`, `Staging branch:`, `Worker revision:`, `PR head SHA:`, `Base SHA:`, `Staging project ref:`, `Cloud Run service/tag URL:` (URL), `Image digest:` (`sha256:<64 hex>`), `Evidence scope:` (exactly `merge-grade shared staging` or `merge-grade isolated staging`), `Preflight timestamp:` (≤ Soak start), `Preflight result:` (must contain `environment_type=clean_mirror` and none of `soak_artifact`, `fixture_seeded`, `diagnostic-only`, `dirty`, `contaminated`, `staging-only`, `pr-only`, `prod divergence`), `Soak start:`, `Soak end:` (≥ 12 h), `E2E result:`, `Migration applied:`, `Rollback rehearsed:`, `Staging deploy log id:` — plus, not in the label list but validated by `changedBehaviorErrors`: `Changed behavior:`, `Targeted evidence:`, `Load/concurrency evidence:` (must name a load term such as concurrent/burst/throughput/queue/k6/p95/drain and must not be `/health`-only).
- T3: T2 + `Trigger A fires:`, `Trigger B fires:`, `Daily flush observation:`, `Per-org isolation check:` (each non-empty, non-placeholder); ≥ 48 h.
- Frontend-T2 (`T2_FRONTEND_FIELDS`, only when declared T2 AND every changed file is frontend-only): `Tier:`, `PR head SHA:`, `RM-approved targeted evidence:` (must contain "approved" and Carson/RM), `Async-cycle floor:`, `E2E result:`, `CI/E2E green:`, `Rollback plan:` + `Changed behavior:` / `Targeted evidence:` / `Load/concurrency evidence:`. Not used here: #2528 declares T1 and is required-tier T1 (root `package.json` is not frontend-only anyway).
- Every non-T0 path first runs `approverIndependenceErrors` over the three note headers (`### Residual-risk note`, `### Unsoakable-surface note`, `### Base-drift residual-risk note`): `Approved by:` may not be a self-reference or the author's login. Custom headers are not parsed.

(c) **RC manifest** (`RC manifest path: docs/staging/rc-manifests/rc-*.json` present ⇒ the body's other fields are NOT validated; the manifest is): path must match the pattern and must not be in the PR's own diff; JSON; `soak_mode` absent or exactly `deferred_consolidated_soak` (any other value = immediate hard error); `schema_version` 1; `rc_id`, `created_at`, `created_by`, `release_owner`, `train_launch_sha` non-empty; current base covered (listed in `train_launch_sha` / `target_main_sha` / `allowed_base_shas` / `covered_main_shas`, or descending from one of them by `git merge-base --is-ancestor`); `approval_status` exactly `approved` (bare `pending` is a placeholder), `approval_actor`, `approval_time` (timestamp); `included_prs[]` entry found by number or head; entry `head_sha` == live head (exact — `roster` binding was removed); entry `base_sha` equal to the live base / `train_launch_sha` / `target_main_sha` / entry `allowed_base_shas`, or (ancestry) `train_launch_sha` ⊑ base_sha ⊑ live base; entry `risk_tier` ≥ required and ≥ declared; entry `owner`, `ci_summary`, `rollback_note` non-empty; `migration_files` for migration PRs; `environment.evidence_scope` merge-grade, `staging_api_base` + `staging_url` URLs (not the shared `arkova-worker-staging`), `revision`, `deploy_tag`, `image_digest`, `supabase_project_ref`, `deploy_log_id`, `preflight_result` (clean_mirror, same word filter); `soak.start`/`end` (end − start ≥ tier minimum, `duration_hours` ≥ minimum if present), `soak.result` passing word, `soak.harness_version`, `soak.evidence_links` ≥ 1, `soak.expires_at` > now; `migration_plan` (order, rollback_proof, reapply_proof) for T3 or migration PRs. No future-timestamp check on the RC path.

(d) **Head SHA.** Standard/T1/frontend/unsoakable paths: the body's `PR head SHA:` (first 40-hex token) must equal `HEAD_REF_SHA`. RC path: the manifest entry's `head_sha` must equal it. Base: standard T2/T3 compares the body's `Base SHA:` with `BASE_REF_SHA`; on mismatch it classifies the main drift between the two (disjoint → ok; T0-only → `Base drift impact:` attestation; same-file T2+ drift or a landed `.sql` while the PR owns one → unclearable; otherwise a `### Base-drift residual-risk note`).

## 2. Two ways it was run

### 2a. Harness — the gate's exported `check()` with `main()`'s option shape

`inputs/gate-harness.ts` (run it from inside the repo tree — the archived copy under `inputs/` is for reading; outside a `"type": "module"` package tsx compiles it as CJS and rejects the top-level await). It passes the live head/base, `prNumber`, `prAuthor=carson-see`, a `/usr/bin/git merge-base --is-ancestor` ancestry provider, a git diff provider, the PR's file list from `gh pr view --json files` (`inputs/pr-NNNN-files.json`), and either the committed manifest (`inputs/rc-batch-2026-09-02.COMMITTED.json`, sha256 4dd8401a…) or the corrected draft. `--now` only affects the RC `expires_at` check and the bypass window: the standard path calls `futureTimestampErrors(body)` with the real clock (`check()` does not thread `nowMs` into it), so a future `Soak end` cannot be simulated away. Exact invocations: `inputs/run-dry-run.sh`, `inputs/run-dry-run-2.sh`; every output is verbatim under `out/`.

Placeholder substitutions used for the "close-out simulated" variants (`inputs/make-variants.mjs`, `inputs/make-variants-2.mjs`; every value is marked SIMULATED inside the variant): `Soak end` 2026-09-04T13:38:43Z (#2524); `<<APPROVER: Carson>>` → `Carson (founder) — approval recorded on the PR …`; rollback rehearsal → a dated apply/rollback/re-apply sentence; Cloud Build id → `DRYRUN-SIMULATED-cloud-build-id`; cycle counts 9 (#2524) / 6 (RC); midnight cycles, per-org probe and #2528 spec run → dated sentences; manifest `approval_time` 2026-09-03T08:30:00Z, `expires_at` 2026-09-10T07:49:27Z. CLOCK-SHIFTED variants move `Preflight timestamp` / `Soak start` / `Soak end` back 2 d (#2524) or 1 d (RC standalone) so the window sits in the past; they exist only to prove every other validator passes.

### 2b. Real binary — `main()` with the workflow's env, on each PR's merge preview

`inputs/cli-run.sh`: with the worktree checked out at the PR's GitHub merge preview (`refs/pull/N/merge`, fetched read-only), it runs

```
GH_BIN=/opt/homebrew/bin/gh GIT_BIN=/usr/bin/git PR_NUMBER=N HEAD_REF_SHA=<head> BASE_REF_SHA=<base> \
PR_AUTHOR=carson-see GITHUB_REF=refs/pull/N/merge PR_BODY="$(cat <body>)" \
node_modules/.bin/tsx scripts/ci/check-staging-evidence.ts
```

exactly as `.github/workflows/staging-evidence.yml` does (`node_modules/.bin/tsx` from the main checkout; `SOAK_GATE_DISABLED` / `DEPLOY_WORKER_PAUSED` unset = not engaged). For the "corrected manifest" runs the corrected JSON was copied to `docs/staging/rc-manifests/rc-batch-2026-09-02-CLOSEOUT-DRYRUN.json` (untracked) for the duration of one run and removed; the body variant used cites that path. Outputs: `out/cli-2524.txt` … `out/cli-2528.txt`.

## 3. Verdicts

### 3.1 PR #2524 — T3, standard path (`out/2524-*.txt`, `out/cli-2524.txt`)

Classifier on all runs: `requiredTier=T3 (services/worker/src/chain/confirmation-proof.ts — chain/treasury hot path); frontendOnly=false` — matches the declared T3.

Draft as-is, live clock, live base (2524-A):
```
::error::Soak end could not parse as a timestamp: `<<FILL AT CLOSE-OUT>>`.
❌ 1 error(s) — gate FAILED.
```
Close-out values substituted, real window, live clock — real binary (`cli-2524.txt`, checkout e480b1166 = GitHub's preview, parents 4b3db0c0c + e5815e9ac):
```
::error::Soak end: `2026-09-04T13:38:43Z` is in the future; planned/future evidence cannot start or complete a soak clock.
exit=1
```
(harness 2524-B: the identical single error.) Same body with the window CLOCK-SHIFTED −2 d (SIMULATED) — real binary:
```
✅ Staging soak evidence gate passed.
exit=0
```
(harness 2524-B2: `✅ Staging soak evidence gate passed.`) Every validator other than the real-clock future check therefore passes on this block: labels, head SHA, base SHA, scope, preflight (clean, pre-clock), 48 h duration, artifact fields, the four T3 trigger fields, changed-behavior / targeted / load fields, approver checks.

What-if, base.sha moved to today's main tip f82595200 (2524-C):
```
::error::Base SHA drift from `4b3db0c0c4aaa28b1df5506c59357835f6f995a7` to `f825952001a2f436b575b62fa4d11946e76ff3eb`: main landed a migration in the interval (supabase/migrations/0417_cleanup_expired_data_singleton_advisory_lock.sql) and this PR owns a migration. Ledger ordering is shared mutable state and cannot be attested away — re-soak on the current base (FD-GATE-3).
::error::Soak end: `2026-09-04T13:38:43Z` is in the future; …
❌ 2 error(s) — gate FAILED.
```
What-if, body `Base SHA` written as the soaked image's own base 5c145df5 (2524-D):
```
::error::Base SHA drift from `5c145df5cd72d10060f1c84308b72bda74d29c9a` to `4b3db0c0c4aaa28b1df5506c59357835f6f995a7` touches this PR's soak surface: main edited file(s) this PR itself soaked or declared as dependencies (docs/api/agents.md, packages/sdk/src/agents.md, packages/sdk/src/client.test.ts, packages/sdk/src/types.ts, packages/verifier-cli/agents.md, packages/verifier-cli/src/types.ts, packages/verifier-cli/src/verify.ts, services/worker/src/api/v1/agents.md, services/worker/src/routes/agents.md, services/worker/src/routes/cron.ts, services/worker/src/utils/agents.md, src/lib/agents.md, supabase/migrations/agents.md) at T2 (docs/api/agents.md — public API contract / SDK surface). The completed soak describes code that no longer exists; a residual-risk note cannot cover same-file T2+ drift — re-soak on the current base (FD-GATE-3).
```
Conclusion for #2524: the block passes the moment `Soak end` is real (≥ 2026-09-04T13:38:43Z) with `Base SHA` = GitHub base.sha 4b3db0c0c, provided base.sha has not moved. The E2 head-vs-image situation is invisible to the gate (it only compares head and base SHAs) and is carried honestly in the block's own note, per the CTO decision.

### 3.2 RC PRs with the manifest AS COMMITTED — fail today, two different ways

Harness, draft body + committed manifest (2525-A, 2526-A, 2527-A, 2528-A — identical text on all four):
```
::error::RC manifest soak_mode "isolated_rig_soak" is not a recognized value. The only supported value is "deferred_consolidated_soak"; omit the field entirely to use the normal (non-deferred) evidence path.
❌ 1 error(s) — gate FAILED.
```
Real binary on the merge previews GitHub currently holds (first parent 0faa5bd5d for #2525/#2526/#2527, b5e823c3 for #2528 — all older than the manifest commit 607cb8d70), draft body (`cli-25xx.txt`, run A):
```
::error::RC manifest `docs/staging/rc-manifests/rc-batch-2026-09-02.json` was not found in the checked-out PR tree.
exit=1
```
So the CI job today would not even reach the `soak_mode` error; it fails on the manifest's absence from the preview tree. Both must be cleared (see closeout-checklist.md §2a).

### 3.3 RC PRs with the CORRECTED manifest — pass

Corrections applied (diff in §4): `soak_mode` removed; `approval_status: approved` + `approval_actor` + `approval_time`; `environment.revision` / `deploy_tag` / `deploy_log_id` added; `soak` object added; #2526 `base_sha` → 19d7adfb.

Harness with the simulated clock 2026-09-03T08:30Z (2525-B, 2526-B, 2527-B, 2528-B) and with the LIVE clock while the window is still open (25xx-B-live) — identical on all eight runs:
```
ℹ️  RC manifest coverage accepted for RC-2026-09-02-batch; long soak evidence is centralized at the release-candidate level.
✅ Staging soak evidence gate passed.
```
Real binary on the current GitHub previews, close-out body citing the temporary corrected manifest (`cli-2525.txt` … `cli-2528.txt`, run E):
```
ℹ️  RC manifest coverage accepted for RC-2026-09-02-batch; long soak evidence is centralized at the release-candidate level.
✅ Staging soak evidence gate passed.
exit=0
temp manifest removed: yes
```
Classifier per PR: #2525 `T2 (services/worker/src/api/v1/router.ts — public API surface)`; #2526 `T2 (services/worker/src/jobs/scheduler-manifest.ts — worker queue/concurrency behavior)`; #2527 `T2 (docs/api/openapi.yaml — public API contract / SDK surface)`; #2528 `T1 (default frontend / additive change)`; `frontendOnly=false` for all (so the frontend-T2 path never engages; #2528 rides the manifest's T1 entry, 12 h ≥ 2 h).

### 3.4 #2526 with the manifest's recorded base_sha left at 5c145df5 (2526-B0)
```
::error::RC manifest current PR entry base SHA does not match the current base, train launch SHA, target main SHA, an allowed base SHA, or an ancestor of the current base.
❌ 1 error(s) — gate FAILED.
```
The ancestry fallback cannot rescue it because `train_launch_sha` (78621249…, the RC tree tip) is not an ancestor of any main commit.

### 3.5 Standalone fallback — RC bodies with the `RC manifest path:` line removed

Live/simulated clock (25xx-C): one error each, `Soak end: 2026-09-03T07:49:27Z is in the future…`. Window CLOCK-SHIFTED −1 d (25xx-C2, live clock), all four: `✅ Staging soak evidence gate passed.` — i.e. every per-PR field set (standard T2 for #2525/#2526/#2527, T1 for #2528 including the value-checked `Human approver:`, `Health/smoke result:`, `CI/E2E green:`, staging URL) is well-formed and would carry each PR on its own once the window is past, should the manifest approval slip.

## 4. Manifest changes the RC path needs (`out/manifest-diff.txt`, committed → corrected draft)

```
-  "soak_mode": "isolated_rig_soak",
-  "approval_status": "pending",
+  "approval_status": "approved",
…
+    "revision": "arkova-worker-rc-batch-0902-staging-00001-p4l",
+    "deploy_tag": "arkova-worker-rc-batch-0902-staging (isolated service URL; no traffic tag)",
+    "deploy_log_id": "cloud-run rev arkova-worker-rc-batch-0902-staging-00001-p4l created 2026-09-02T19:48:33Z (Cloud Build id <<FILL AT CLOSE-OUT: cloud-build-id>>); no staging_deploy_log row — deployed directly, not via scripts/staging/deploy.sh"
…
       "number": 2526,
-      "base_sha": "5c145df5cd72d10060f1c84308b72bda74d29c9a",
+      "base_sha": "19d7adfbdd48ba87d9980364c2699c73317dffd4",
…
+  "approval_actor": "Carson",
+  "approval_time": "<<FILL AT CLOSE-OUT: approval-time>>",
+  "soak": {
+    "start": "2026-09-02T19:49:27Z",
+    "end": "2026-09-03T07:49:27Z",
+    "duration_hours": 12,
+    "harness_version": "services/worker/scripts/rc-batch-0902-driver.ts@31569f76e… (sha256 29fd4c4d…) + e2e/rc-batch-0902-frontend-evidence.spec.ts@31569f76e for #2528",
+    "result": "pass — <<FILL AT CLOSE-OUT: cycle-count>> two-hourly cycles, 17/17 assertions each, evidenceForSoak=true; …",
+    "evidence_links": [ …five paths under docs/staging/rc-batch-0902/evidence/… ],
+    "expires_at": "<<FILL AT CLOSE-OUT: expires-at>>"
+  }
```
The unicode-escape lines in the diff (`—` → `—`, `∈` → `∈`, `§` → `§`) are JSON re-serialization only, not content changes. Full draft: `inputs/rc-batch-2026-09-02.CLOSEOUT-DRAFT.json`. It must land on main in its own `docs(rc):` PR (CODEOWNERS `docs/staging/rc-manifests/ @carson-see`; a PR that cites and modifies the manifest is rejected).

## 5. What the gate does not catch (observed, not inferred)

- **`<<…>>` markers.** Variant 2524-A3 — window clock-shifted, the other seven `<<FILL AT CLOSE-OUT: …>>` markers left in `Rollback rehearsed:`, `Staging deploy log id:`, `Trigger B fires:`, `Daily flush observation:`, `Per-org isolation check:`, `Human approver:` and the note's `Approved by:` — `✅ Staging soak evidence gate passed.` (`out/2524-A3.txt`). The placeholder regex is anchored to a whole value of the form `<x>`; a double bracket or any surrounding prose defeats it. Only the timestamp fields (`Soak end`, `Soak start`, `Preflight timestamp`) fail loudly on a marker. Close-out control: grep the pasted body for `<<`.
- **Human approver identity.** `Human approver: Carson (founder) — …` passes on a PR authored by `carson-see`: the T1 check is value-only by design (scripts/ci/agents.md, seventh closure), and the note checks only reject an exact login token. The gate cannot see whether the human named actually approved.
- **`Staging deploy log id:` / `Rollback rehearsed:` semantics.** Both accept any non-placeholder text; the provenance sentence (Cloud Run revision + admission JSON, no `staging_deploy_log` row) and a truthful "not rehearsed" sentence would both pass. The §1.12 requirement is enforced by the reviewer, not the parser.
- **Head vs soaked image.** The gate compares `PR head SHA` with the live head only; it cannot see that #2524's rig runs a3f1d6b36 while the head is e5815e9ac. Carried by the block's own note (CTO decision E2).
- **RC path and time.** No future-timestamp check on `soak.end`; an approved manifest passes while its window is open (25xx-B-live). `approval_status: approved` is the only control, so approval must not be granted before the window closes and the last cycles are committed.
- **RC path and the body.** With `RC manifest path:` present, none of the per-PR body fields are validated (only the heading, `Tier:`, the path, and note-approver independence). The per-PR fields in the drafts are for the auditor; they were separately proven well-formed via the standalone variants (§3.5).
- **CI status.** The gate does not read check results: the red `Tests` job on all four RC heads (and on main) is invisible to it and is a Mergify concern.

## 6. Files

- `pr-2524-evidence-block.md`, `pr-2525-…`, `pr-2526-…`, `pr-2527-…`, `pr-2528-evidence-block.md` — the blocks to paste (markers intact).
- `inputs/` — harness, variant generators, runners, PR file lists, committed manifest copy, corrected manifest draft.
- `variants/` — every graded body/manifest variant (SIMULATED values; never paste these).
- `out/` — verbatim gate output per variant, `cli-*.txt` from the real binary, `manifest-diff.txt`.
- `closeout-checklist.md` — what must be filled or fixed, per PR, and what the current evidence cannot satisfy.


## 7. Post-run addendum (2026-09-02T21:40Z) — origin/main advanced during the session

While the runs above were executing, origin/main moved from f825952001a2f436b575b62fa4d11946e76ff3eb to 4b30a0f65b86ceefe768de547a80495ed9a1e40c (one docs-only commit: HANDOFF.md, docs/staging/findings/prod-block-height-2026-09-02/*, and two new E3 files — docs/staging/proof-txincl-0427/evidence/E3-scheduler-trigger-observation-2026-09-02T2038Z.md and docs/staging/rc-batch-0902/evidence/E3-scheduler-trigger-observation-2026-09-02T2038Z.md). scripts/ci/ is untouched by that commit, so every verdict above stands for the current gate. None of the five hosted base.sha values changed.

The E3 files independently record the same trigger reading the #2524 block uses (Trigger A = the */5 populate sweep, 122 × HTTP 200 executions 13:37:23Z–20:35:00Z, 0 non-2xx; Trigger B = the driver re-arm + tick sequence; no daily flush on the rig by design) and, for the RC rig, 10 × 200 each for populate-confirmation-proofs and check-confirmations plus 2 × 200 for the driver POSTs to /jobs/detect-reorgs. The blocks for #2524, #2525, #2526 and #2527 now cite them. The #2524 risk rationale also states its relationship to the new open prod finding SCRUM-3953 (anchor_proofs.block_height stale on 99.6 % of prod rows): the PR diff only relocates the existing values.block_height = row.blockHeight assignment and widens the anchor_proofs select (checked with a diff of the three worker files against 4b3db0c0c), so the PR neither fixes nor worsens it.

Re-grade of the edited blocks with the same simulated substitutions (out/2524-F.txt, out/2525-F.txt, out/2526-F.txt, out/2527-F.txt; leftover markers 0 in each variant):

- 2524-F (window CLOCK-SHIFTED −2 d, live base): `✅ Staging soak evidence gate passed.`
- 2525-F / 2526-F / 2527-F (corrected manifest, live clock): `ℹ️  RC manifest coverage accepted for RC-2026-09-02-batch; long soak evidence is centralized at the release-candidate level.` / `✅ Staging soak evidence gate passed.`

#2528 was not edited after its runs (§3.3, §3.5).
