# Close-out checklist — PRs #2524, #2525, #2526, #2527, #2528

Drafted 2026-09-02T21:30Z against origin/main f825952001a2f436b575b62fa4d11946e76ff3eb and the live GitHub state read at 20:4xZ. Every item below is something the draft blocks cannot settle today, or a gate condition that must still be true at the moment the block is pasted. Gate = `scripts/ci/check-staging-evidence.ts` via `.github/workflows/staging-evidence.yml`; the local pre-merge hook `.claude/hooks/check-staging-evidence-pre-merge.sh` runs the same script before `gh pr ready` / `gh pr merge`.

## 0. Before pasting ANY block (all five PRs)

- [ ] Re-read the live head and base and compare with the block: `gh api repos/carson-see/ArkovaCarson/pulls/N --jq '{head:.head.sha, base:.base.sha, merge_commit_sha:.merge_commit_sha, mergeable_state:.mergeable_state}'`. A changed head voids the block (`PR head SHA:` must equal `.head.sha` exactly). Values at draft time: #2524 e5815e9ac/4b3db0c0c, #2525 24fbb72cc/8147ed3a7, #2526 c646d18e8/19d7adfbd, #2527 2cb005850/4b3db0c0c, #2528 7781bf0eb/b5e823c3a.
- [ ] `gh variable get SOAK_GATE_DISABLED` must print `false` (it did on 2026-09-02); a green gate with `true` proves nothing.
- [ ] Replace every `<<APPROVER: Carson>>`. What the gate accepts: a non-empty value that is not a placeholder (`TBD`, `pending`, `N/A`, `NONE …`, `nobody`), not the agent (`Claude`, `Claude Code`, `@claude`), and not a self-reference (`me`, `myself`, `the author`). For the three note sections (`### Residual-risk note`, `### Unsoakable-surface note`, `### Base-drift residual-risk note`) the value may also not contain the PR author's login `carson-see` as a token. A display name such as `Carson (founder) — approved 2026-09-04` passes; the gate does not map display names to logins, so it cannot tell that Carson is also the author — that check is a policy call, not a gate rule.
- [ ] `grep -n '<<' <pasted body>` must return nothing. The gate's placeholder guard matches `<x>` (one angle bracket) as a whole value but does NOT match `<<x>>`, and does not scan values that merely contain a marker. Proven: variant 2524-A3 (window clock-shifted, all other `<<FILL AT CLOSE-OUT: …>>` markers left in place) PASSED the gate — see gate-dry-run.md §5.
- [ ] Re-run the dry run on the final body before pasting (harness command in gate-dry-run.md §2a; it takes ~2 s) and again after pasting via the CI job.
- [ ] The `Tests` job is red on all four RC heads AND on main (run 33669376517 at e99c6cb7): `src/routes/health-detail-auth.test.ts` (added to main by #2584). #2528 additionally fails `src/components/organization/InviteMemberModal.test.tsx` on its preview. The evidence gate does not read CI results, but Mergify does — fix or explicitly accept on main before expecting any RC PR to merge, and keep the `CI/E2E green:` / `E2E result:` wording honest (the drafts say "Not green").

## 1. PR #2524 — T3 standard path (no manifest)

Fill at close-out (the drafts mark each with `<<FILL AT CLOSE-OUT…>>`):

- [ ] `Soak end:` — the moment Cloud Run revision `arkova-worker-proof-txincl-0427-staging-00001-f8j` has served ≥ 48 h continuously: declared 2026-09-04T13:38:43Z. Confirm from the revision's uptime, not the wall clock (a restart resets the clock — HANDOFF `### Soaks`). Until this timestamp is in the past the gate fails with exactly one error (`Soak end … is in the future`) — verified with the real binary, gate-dry-run.md §3.1.
- [ ] `Trigger B fires:` — the count of complete driver cycles (A1–A9 9/9, `evidenceForSoak=true`, `withinDeclaredWindow=true`) from the R1 loop's JSONL; commit the loop's rows under docs/staging/proof-txincl-0427/evidence/ (docs push to main; mind `memory/feedback_docs_push_livelocks_mergify.md` if a train is embarked).
- [ ] `Daily flush observation:` — name the cycles that straddle 2026-09-03T00:00Z and 2026-09-04T00:00Z.
- [ ] `Per-org isolation check:` — optional read-only probe: GET /proof for one public_id per org, confirm each fingerprint matches its own row. If skipped, delete the probe sentence and leave the "not measured" statement; the field still passes (it is only checked for non-placeholder text).
- [ ] `Rollback rehearsed:` — **no 0427 rollback rehearsal exists** (searched docs/staging/proof-txincl-0427/, HANDOFF, the driver branch). It cannot run mid-window (it drops the columns under test). After Soak end, on the same rig: apply → rollback via the `-- ROLLBACK:` block with `SET LOCAL lock_timeout = '5s'` → confirm /proof answers 500 not 404 (B2) → re-apply → confirm 200 → reconcile the ledger row to `0427` (§0 rule 10) → record timestamps. This is a rig DB operation: per §1.11A it needs the operator's explicit approval of the exact statements. The gate accepts any non-placeholder text here, so a truthful "not rehearsed" would also pass the gate — but §1.12 T3 requires the rehearsal; do not mark Ready without it.
- [ ] `Staging deploy log id:` — no `public.staging_deploy_log` row exists (manual standup after provision-isolated-rig.sh failed twice). Add the Cloud Build id for image sha256:daa5e411… (read-only: `gcloud builds list --project arkova1 --filter='results.images.digest:daa5e411'`). The gate accepts the provenance text as-is; SCRUM-1803's intent (a deploy.sh audit row) is not met — get Carson's explicit acceptance or backfill a row through `record_staging_deploy` on the rig.
- [ ] `Human approver:` and the note's `Approved by:` — Carson.

Conditions that must still hold when the CI job runs:

- [ ] GitHub `base.sha` for #2524 must still be `4b3db0c0c4aaa28b1df5506c59357835f6f995a7`. It did not follow main during the day (base.sha equals the PR's merge-base for four of the five PRs), but if it moves to any commit at or after 1b7d8601c (where `supabase/migrations/0417_cleanup_expired_data_singleton_advisory_lock.sql` landed on main) the gate hard-fails with the unclearable ledger carve-out — verified in variant 2524-C: "main landed a migration in the interval (…0417…) and this PR owns a migration … re-soak on the current base (FD-GATE-3)". No note can clear it; the only remedies are a re-soak on the new base or the base.sha staying put. Do NOT merge main into `feat/proof-tx-inclusion-branch` before it merges (new head → evidence void per §1.11A and the E2 note's own void condition; the PR's tree also lacks 0417, so a merge would bring runtime files from main).
- [ ] Keep `Base SHA: 4b3db0c0c…` — do not "correct" it to the soaked image's base 5c145df5: variant 2524-D shows that spelling trips carve-out (a) on 13 same-file T2 drift files (routes/cron.ts among them) and fails closed.
- [ ] Separate red check, not the evidence gate: `Check supabase/migrations vs prod` fails until 0427 is prod-applied per §0 rule 10, with its prefix added to `scripts/ci/snapshots/ledger-numeric-exemptions.json` in the same motion (hook `.claude/hooks/check-prod-migration-apply.sh`). RTE owns this (`memory/feedback_rte_owns_prod_migration_apply.md`).
- [ ] Replace the PR description's `## Soak evidence — To follow` paragraph with the block; keep the block's `## Staging Soak Evidence` heading exact.
- [ ] PR is Draft. After the gate is green: `gh pr ready 2524` (the local hook re-runs the check). Mergify then queues it (`needs-carson-merge` is informational, per memory). Never `gh pr merge`.

## 2. RC batch — PRs #2525, #2526, #2527 (T2) and #2528 (T1)

### 2a. The manifest must change first (its own `docs(rc):` PR to main; CODEOWNERS `docs/staging/rc-manifests/ @carson-see`; a PR may not cite and modify the manifest in the same change)

The committed `docs/staging/rc-manifests/rc-batch-2026-09-02.json` fails the gate before anything else is read. Required edits, all verified by dry run (gate-dry-run.md §3.2–3.5, diff in §4):

- [ ] Remove `"soak_mode": "isolated_rig_soak"` — the gate accepts only the literal `deferred_consolidated_soak` or the field's absence; any other value is a hard error that returns early (`RC manifest soak_mode "isolated_rig_soak" is not a recognized value…`).
- [ ] `approval_status: "approved"` (the bare word `pending` is an incomplete-placeholder value on the normal path), plus `approval_actor` (non-empty) and `approval_time` (parseable timestamp). Carson grants this AFTER the window closes and the final cycles are committed — the gate applies no future-timestamp check to `soak.end`, so an approved manifest passes even while the window is open (variants 25xx-B-live). The approval is the only control on that.
- [ ] `environment.revision`, `environment.deploy_tag`, `environment.deploy_log_id` — all three are required keys and are absent (`cloud_run_revision` is not read). Draft values are in inputs/rc-batch-2026-09-02.CLOSEOUT-DRAFT.json; fill the Cloud Build id for sha256:55c34e1f… (read-only `gcloud builds list --project arkova1 --filter='results.images.digest:55c34e1f'`). No `staging_deploy_log` row exists for this rig either.
- [ ] Add the `soak` object: `start` 2026-09-02T19:49:27Z, `end` 2026-09-03T07:49:27Z, `duration_hours` 12, `harness_version`, `result` (must contain green/pass/success/ok/healthy — fill the final cycle count), `evidence_links` (≥ 1), `expires_at` (must be later than the moment the CI job runs; the draft leaves it as a marker — pick a date after the expected merge, e.g. 2026-09-10T07:49:27Z).
- [ ] `included_prs[#2526].base_sha` → `19d7adfbdd48ba87d9980364c2699c73317dffd4` (GitHub's live base.sha). The committed value 5c145df5 is the merge-base, and exact match is the only path that can pass: `train_launch_sha` is the RC tree tip 78621249… (not a main commit), so the ancestry fallback can never hold. Verified: variant 2526-B0 fails with "RC manifest current PR entry base SHA does not match…", 2526-B passes with the fix.
- [ ] Optional, README-consistent: `train_launch_sha` should be the frozen MAIN base the RC tree was built on (e99c6cb7028843b863ad6492c8e8cf81c6f591da per the admission JSON), not the RC tip; the gate does not require this.
- [ ] Optional honesty edits: the `ci_summary` strings should say the `Tests` job is red (health-detail-auth, pre-existing on main); #2525's summary says the park is a 404 — correct (the PR description's "Parked at 501" paragraph is stale, as is #2526's "maxSilenceMs 1 * HOURS": the head has 30 min).
- [ ] After the manifest PR merges, every RC PR's merge preview must be recomputed by GitHub against a main that contains it. Today's previews (refs/pull/N/merge) were computed at 15:3x–15:5xZ against 0faa5bd5d (#2525/6/7) and b5e823c3 (#2528), both BEFORE the manifest commit 607cb8d70 (19:52Z) — the real binary on those previews fails with "RC manifest … was not found in the checked-out PR tree" (gate-dry-run.md §3.2). Verify before expecting green: `git fetch origin refs/pull/N/merge && git rev-list --parents -n1 FETCH_HEAD` — the first parent must contain the manifest fix. If GitHub reports `mergeable_state: unknown`, the workflow falls back to the branch head checkout, which never contains the manifest; wait and re-trigger (a body edit fires the `edited` event). If the preview will not refresh, the documented fallback is restacking the branch on main — which changes the head, re-pins the manifest, and reopens the exact-head question; avoid unless forced.

### 2b. Per-PR body fills

- [ ] #2525 / #2526 / #2527 / #2528: `<<FILL AT CLOSE-OUT: cycle-count>>` in `E2E result:` — number of two-hourly `rc-live-NN` cycles with 17/17 (the loop runs every 2 h until 07:49:27Z; 6 expected). Commit every cycle's JSONL under docs/staging/rc-batch-0902/evidence/.
- [ ] `<<FILL AT CLOSE-OUT: cloud-build-id>>` in `Staging deploy log id:` (same id as the manifest).
- [ ] `<<APPROVER: Carson>>` in `Human approver:`.
- [ ] #2528 only: `<<FILL AT CLOSE-OUT: spec-run>>` — either run `e2e/rc-batch-0902-frontend-evidence.spec.ts` (branch soak/rc-batch-0902-driver) against a served build (`npm run build && npx vite preview --port 5173 --strictPort`, then `npx playwright test e2e/rc-batch-0902-frontend-evidence.spec.ts --project=chromium`) and commit its JSON next to the QR evidence, or delete that sentence. The committed evidence (frontend-2528-qr/) already carries the YES verdict; the spec is the served-build complement.
- [ ] `Soak end:` (all four): confirm revision `arkova-worker-rc-batch-0902-staging-00001-p4l` served the full 12 h without restart (E2 recorded uptime 2597 s → 2650 s across the rehearsal, i.e. continuous). If it restarted, the clock restarted.
- [ ] None of the body fields are validated on the RC path (only the heading, `Tier:`, `RC manifest path:`, and the approver-independence check on note sections); they are there for the auditor. The standalone fallback (manifest line removed) also passes once the window is in the past — variants 25xx-C2 — so if the manifest cannot be approved in time, the per-PR blocks stand on their own at close-out (2526's `Base SHA` there is the live 19d7adfb).

### 2c. Order of operations

1. Window closes 2026-09-03T07:49:27Z; final driver cycles + #2528 spec output committed to docs/staging/rc-batch-0902/evidence/ (docs-only push to main).
2. Manifest fix PR (T0; one approval by the CODEOWNER) merged.
3. Paste the four bodies (fills done, no `<<` left). #2528 is NOT a draft: a green gate on a non-draft PR is the merge authorization (`memory/feedback_do_not_merge_means_open_as_draft.md`) — paste #2528's block only when it is meant to merge; today its `Tests` job would still hold Mergify.
4. Confirm each merge preview contains the manifest (2a, last item); the `Staging Soak Evidence Gate` job re-runs on the body edit.
5. `gh pr ready` for #2525 / #2526 / #2527 once green. Never `gh pr merge`.
6. #2527 and #2524 conflict in `services/worker/src/api/v1/docs.ts` (two adjacent OpenAPI lines; union resolves) — whichever merges second needs the conflict resolved, which changes that PR's head and voids its block. Decide the order before readying either.

## 3. Gate demands the current evidence cannot satisfy (summary)

| PR | Demand | Status | Resolution |
|---|---|---|---|
| #2524 | `Soak end:` in the past, ≥ 48 h after start | window open until 2026-09-04T13:38:43Z | time |
| #2524 | `Rollback rehearsed:` (T3 required field) | no 0427 rehearsal exists | run after Soak end, on the rig, with operator approval |
| #2524 | `Staging deploy log id:` real artifact | no staging_deploy_log row (manual standup) | provenance text passes the gate; Carson to accept or backfill |
| #2524 | Base SHA unchanged vs GitHub base.sha | 4b3db0c0c today | if base.sha moves past 1b7d8601c → unclearable 0417 ledger wall → re-soak |
| #2525–#2528 | manifest `soak_mode` absent | `isolated_rig_soak` committed | docs(rc) PR |
| #2525–#2528 | manifest approved (`approval_status`, `approval_actor`, `approval_time`) | pending / absent | Carson, after window close |
| #2525–#2528 | manifest `environment.revision` / `deploy_tag` / `deploy_log_id` | absent | docs(rc) PR |
| #2525–#2528 | manifest `soak` object with `expires_at` in the future | absent | docs(rc) PR |
| #2526 | manifest entry `base_sha` == GitHub base.sha | 5c145df5 vs 19d7adfb | docs(rc) PR |
| #2525–#2528 | manifest present in the checked-out merge preview | previews predate the manifest commit | GitHub must recompute previews after the fix lands |
| #2525–#2528 (Mergify, not this gate) | `Tests` green | red on main and all four previews (health-detail-auth) | fix on main or explicit acceptance |


## 4. Addendum (2026-09-02T21:40Z) — main moved; one new open finding

- origin/main is now 4b30a0f65 (docs only). The five hosted base.sha values did not change; §1 "base.sha must remain 4b3db0c0c" still holds and is unaffected by docs commits landing on main (base.sha did not follow main all day).
- The E3 scheduler-trigger observations now exist for both rigs and are cited in the blocks; keep them in the evidence directories (they are on main).
- [ ] #2524, CTO decision needed: open prod finding SCRUM-3953 (anchor_proofs.block_height stale on 711,250 / 714,129 prod rows, since PR #761; populate job re-asserts the stale value; T3 fix design in docs/staging/findings/prod-block-height-2026-09-02/finding.md). #2524 changes the populate job and the anchor_proofs write path but does not change how block_height is sourced (diff relocates the assignment only). Decide whether #2524 merges before, with, or after the SCRUM-3953 fix; the block states the relationship but claims no fix.
