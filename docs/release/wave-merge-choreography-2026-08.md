# Wave Merge Choreography — 2026-08 Launch

> **Scope:** the exact merge ORDER for the ~40-PR Sprint A/B wave ahead of the
> 2026-08-10 launch, and the discipline rules that keep a batch this size from
> colliding on shared files or churning the Mergify queue.
> **Ratified by:** CTO ruling R17 (ratified sprint plan, 2026-07-28): "RM's
> wave plan (G→M→D→F→S) + master manifest `rc-2026-08-launch-72h.json`
> ratified."
> **Companion:** [72h-soak-runbook-2026-08.md](./72h-soak-runbook-2026-08.md)
> (SCRUM-2980) — the soak this merge order feeds into.
> **Obeys:** `CLAUDE.md` §1.13 (tiered merge, Mergify auto-merges once green +
> evidence), `release-management-runbook.md` §6 (merge order).
> **Verified live:** PR states, base SHAs, and CI status below were pulled via
> `gh pr list` / `gh pr view` on 2026-07-28 against `main` at
> `ae2209fd771ff088d8f3ef12070f4028cbd421a7`. New Wave-S PRs were still opening
> as of this writing — **re-run the `gh pr list` command in §0 before executing
> any wave**, do not trust the snapshot below past the moment it was taken.

---

## 0.1 Deploy-pause gate (CTO ruling 2026-07-28) — read before merging ANY Wave M/D/F/S PR

`deploy-worker.yml` auto-deploys to prod Cloud Run on every push to `main`
touching `services/worker/**`. Waves M/D/F/S merge T2/T3 worker + migration
PRs BEFORE the 72h soak matures, not after (§0 of
[72h-soak-runbook-2026-08.md](./72h-soak-runbook-2026-08.md)) — that is the
deliberate merge-before-soak sequencing this doc exists to choreograph.
Left ungated, **every worker-touching merge in this wave would auto-deploy
unsoaked chain/billing/migration code straight to prod** the moment Mergify
lands it, defeating the entire point of soaking first.

**Before merging any Wave M/D/F/S PR that touches `services/worker/**`:**
confirm `vars.DEPLOY_WORKER_PAUSED=true` is set on the repo (`gh variable
list` should show it). If it is not set, merging is not blocked mechanically
— set it first, or the merge will trigger a live prod deploy.

Mechanism (full detail: `.github/workflows/agents.md`
"Deploy-worker pause gate"): a `deploy-gate` job in `deploy-worker.yml` reads
the `DEPLOY_WORKER_PAUSED` repository Actions variable. When `true`, the
`deploy` job (image build/push/Cloud Run deploy) is skipped with a loud
`::warning::` + job-summary banner on every push; `pre-deploy-checks`
(typecheck/lint/test/copy-lint) still runs unconditionally, so CI signal on
each merge stays real. `workflow_dispatch` always bypasses the pause — if a
specific hotfix genuinely needs to ship mid-wave, dispatch the workflow
manually rather than unpausing globally.

**Re-enable at the end of the wave:** once the 72h soak (§1 go/no-go of the
soak runbook) is complete and the wave's PRs are either merged-and-verified
or deliberately deferred, `gh variable set DEPLOY_WORKER_PAUSED --body false`
(or delete it) so the next worker-touching merge resumes normal auto-deploy.
Do not leave it paused indefinitely after the wave closes — that silently
reintroduces the pre-existing "merge to `main` doesn't reach prod" gap this
same wave is trying to close out (`revision-drift.yml` will start firing on
the resulting drift within an hour).

## 0.2 Merge-before-soak: `deferred_consolidated_soak` mode (CTO ruling 2026-07-28)

With §0.1's deploy gate engaged, merging an unsoaked T2/T3 PR is safe in the
narrow sense that it can no longer reach prod by itself — but the Staging
Soak Evidence Gate (`scripts/ci/check-staging-evidence.ts`, required by
Mergify via `check-success`) still demands real soak evidence for T1/T2/T3,
and a PR-body evidence block alone satisfies the pre-merge git hook but NOT
that CI gate. Without a mechanism for this, Mergify merges nothing above T0
for the whole wave, soak or no soak.

`docs/staging/rc-manifests/rc-2026-08-launch-72h.json` now carries a
top-level `"soak_mode": "deferred_consolidated_soak"` field. This activates
a distinct, narrower code path in `check-staging-evidence.ts`
(`deferredConsolidatedSoakCoverage()`) that lets a PR listed in the
manifest's `included_prs[]` pass the gate **without** real soak evidence,
subject to hard constraints — full detail in the function's own doc comment
and in `scripts/ci/check-staging-evidence.test.ts`'s
`deferred_consolidated_soak mode` describe block:

- Activated **only** by that exact manifest field — never a PR body string,
  never a label, never anything a PR author controls alone (the manifest is
  its own reviewed file).
- **Hard precondition, checked first, fails closed:** the gate must
  positively confirm `vars.DEPLOY_WORKER_PAUSED === 'true'` on the live run
  (threaded from `staging-evidence.yml`'s `vars` context, resolved fresh at
  CI-run time — not the frozen webhook payload). If the deploy gate isn't
  confirmed engaged, deferred mode refuses to activate and the PR falls back
  to needing real evidence.
- The check's passing output states plainly, every time, that evidence is
  **DEFERRED and NOT satisfied** — it never renders as "evidence present."
- `approval_status` on the manifest stays the literal string `"pending"`
  for as long as `soak_mode` is set — setting it to `"approved"` while
  deferred is active is itself a gate error (that combination claims real
  evidence exists, which deferred mode by definition does not have).
- A PR not listed in `included_prs[]` gets none of this — it needs real
  evidence exactly as before. A manifest without the `soak_mode` field
  behaves EXACTLY as it always has (unit-tested).

**This is a deliberate trade, not a loophole:** evidence-before-merge is
traded for evidence-before-DEPLOY. The residual risk is that `main` carries
unsoaked T2/T3 worker/migration code for the duration of the soak window —
**any hotfix needed during that window must go through the same
`deploy-gate`** (`workflow_dispatch` to force an intentional deploy, or wait
for the wave's soak to mature and the pause to lift). At soak maturity, the
correct sequence is: remove `soak_mode` from the manifest, fill in the real
`environment`/`soak`/`migration_plan` evidence blocks, THEN flip
`approval_status` to `"approved"` — returning to the normal, non-deferred
RC-manifest evidence path this gate has always enforced, and only then
un-pausing `DEPLOY_WORKER_PAUSED` for the wave's single verified deploy.

---

## 0. Live PR inventory as captured (2026-07-28, re-verify before use)

```bash
gh pr list --state open --limit 60 --json number,title,headRefOid,baseRefName,isDraft,labels
```

14 PRs open at capture time, mapped to waves below. Full per-PR detail
(detector-computed risk tier, exact base/head SHA, blocking issues) lives in
[`rc-2026-08-launch-72h.json`](../staging/rc-manifests/rc-2026-08-launch-72h.json)
`included_prs[]` — this doc is the *order*, the manifest is the *evidence*.

---

## 1. Wave order: G → M → D → F → S

### Wave G — gate fixes, FIRST and ALONE (T0/T1, normal Mergify path, no soak)

Per R1: "nothing soaks" ≠ "nothing merges" — T0 needs no soak per §1.12. These
merge **before** anything else in the wave because Wave M/D/F/S's own soak
evidence should be graded by the *fixed* staging-evidence gate, not the buggy
one it's replacing.

| Order | PR | What it fixes | Detector tier |
|---|---|---|---|
| G1 | #1722 | `migration-drift.yml` re-fireable on body edits + stale-checks runbook (SCRUM-3029/3030) | T0 |
| G2 | #1724 | staging-gate stale-`github.sha`-checkout fix + `mint-fresh-event` helper (SCRUM-3026) | T1 |
| G3 | #1723 | orphaned-export lint, fail-closed for new orphans (SCRUM-3032/3033/3034, enforces founder amendment A2) | T1 |

**Action:** merge G1 → G2 → G3 in that order via the normal Mergify T0/T1
path as soon as each is green. Do not batch these with anything else — they
are infrastructure the rest of the wave depends on. G2 in particular is the
PR that fixes the exact bug (stale merge-ref checkout) that blocked the
2026-07-27 10-PR wave; land it before trusting the gate's read of Wave M/D/F/S.

**Before G1:** verify `Tests` is green (was pending/unclear at capture).
**Before G2:** verify `SonarCloud Code Analysis` is fixed (was FAILING at
capture).
**Before G3:** re-verify `Staging Soak Evidence Gate` (showed CANCELLED at
capture — confirm that's a superseded speculative run, not a real failure,
per `memory/feedback_dont_churn_mergify_queue.md`).

---

### Wave M — migration trio, SERIAL, agents.md-verified after each (T3)

Per R13/RTE table: #1615 → #1618 → #1652, **strictly serial**, each one fully
merged (not just queued) before the next starts. This is not a batching
convenience — each migration builds on ledger state the prior one leaves.

| Order | PR | Migration(s) | Blocker to clear first |
|---|---|---|---|
| M1 | #1615 | 0359, 0360 (+ 0361 SCRUM-2916 if claimed) | `Tests` currently FAILING — must fix before this can even enter the soak wave, let alone merge |
| M2 | #1618 | 0362 | Carries `do-not-merge` label — **must be explicitly removed by Carson/RTE** before Mergify queue entry is even possible (`do-not-merge` "Blocks Mergify queue entry" per the label's own description); also self-flagged `[DRAFT — slice freeze]` in its title |
| M3 | #1652 | 0364 | Re-verify all required checks at execution time (not fully enumerated this pass) |

**Procedure per PR in the trio:**
1. Confirm the PR's blocker (above) is cleared.
2. Confirm the isolated-rig 72h soak (`72h-soak-runbook-2026-08.md`) has
   matured and this PR's changed surface has real evidence, not just uptime.
3. Migrate-before-merge (`release-management-runbook.md` §3): RM applies the
   migration to **prod** via Supabase MCP `apply_migration`, reconciles the
   ledger to the numeric `NNNN` prefix (`CLAUDE.md` §0 rule 10), confirms
   `list_migrations` shows the numeric head.
4. **Then** let Mergify merge the PR.
5. **Verify `agents.md` content post-merge, every single time** — see §2
   below. This is not optional even though it worked fine last time; the
   repo's history includes a real incident of parallel PRs colliding on
   `agents.md` (`supabase/migrations/agents.md`, #1031 behind #1022,
   documented in `CLAUDE.md` §6).

   **Clarification (CTO, 2026-07-28):** an earlier draft of this doc marked the
   2026-07-28 agents.md-drop fix "UNVERIFIED — no commit found in
   `git log -- .gitattributes`". That search was in the wrong place, and the
   absence of a commit is expected, not suspicious. Root cause was **local repo
   config, never a tracked file**: this checkout's `.git/config` carried
   `merge.union.driver = true`, which overrides git's *built-in* `union` merge
   algorithm (requested by `.gitattributes: agents.md merge=union`) with the
   shell command `true` — it writes nothing to the merged output and exits 0, so
   git reports a clean merge while silently keeping "ours" and discarding
   "theirs". Fixed by `git config --local --unset merge.union.driver` and
   verified with a scratch-repo test (both sides' rows survive afterward; before,
   the incoming side vanished). `.git/config` is not committed, so **no commit
   exists or should be expected**.

   Blast radius, verified: `main` was never corrupted — GitHub/Mergify merges run
   server-side with the real union driver. Only *local* `git merge origin/main`
   runs inside this checkout dropped content, which is what damaged PRs #1615 and
   #1652 (both caught and repaired during Wave 0). **Any other clone may still
   carry the bad config** — check with
   `git config --local --get-regexp '^merge\.'` before merging there.

   Keep the manual verification step below regardless. It is cheap, and it is
   exactly the failure mode it catches.
6. Move to the next PR in the trio only after steps 1-5 are clean.

**Why serial, not parallel:** all three touch `supabase/migrations/agents.md`
(and #1618 additionally touches `src/lib/agents.md`,
`services/worker/src/ctdl/agents.md`, `services/worker/src/lib/agents.md`,
`src/components/verification/agents.md`) — parallel merges here are exactly
the shared-file collision pattern `CLAUDE.md` §6 already logged an incident
for. Serial execution sidesteps it entirely rather than relying on the union
merge driver to resolve it correctly under concurrent load.

---

### Wave D — DocuSign (T2)

| Order | PR | What |
|---|---|---|
| D1 | #1711 | auto-seed DocuSign Completion queue-mode rule on org connect (SCRUM-3027) |

Single PR, no internal ordering needed. **Before merge:** re-verify the
`Check supabase/migrations vs prod` failure noted in HANDOFF 2026-07-27 as
"not yet investigated" — do not assume it has resolved itself. This PR
carries `needs-carson-merge` (informational tier-marker only per `CLAUDE.md`
§1.13 — not a queue gate).

---

### Wave F — folders + dependency housekeeping (T1)

| Order | PR | What | Blocker to clear first |
|---|---|---|---|
| F1 | #1721 | Folders UI (sidebar, create/rename/delete, move-to-folder) — the fix for the "shipped with zero UI" bug | Base (`51d56af0`) is behind current `main` — rebase/merge main in first |
| F2 | #1716 | Dependabot worker-deps group bump (7 updates) | Base (`08d5cec6`) is behind current `main` — rebase/merge main in first; verify no major-version breaking bump in the 7-update set |

No cross-dependency between F1/F2 — they can merge in either order or in
parallel once each is individually green and rebased.

---

### Wave S — new sprint PRs (T0-T3, mixed)

Everything opened during Sprint A/B that isn't G/M/D/F. At capture time this
was: #1654 (Drive connector, T2, **CONFLICTING/DIRTY — needs rebase before
anything else**), #1725 (TS SDK `anchorBulk()`, T1), #1726 (MCP manifest
parity, T1), #1727 (billing idempotency + migration 0368, T3), #1728
(materializer-EXECUTE runbook, T1, **`TypeCheck & Lint` currently FAILING**).
Many more Wave-S PRs (W1-W9 bulk-upload work, F1-F6 format workstream, L1/L2/L3
Sprint B items per the ratified sprint plan) were still being opened as of
this doc's authoring — **re-run the PR inventory command in §0** before
sequencing Wave S for real.

**Ordering rule within Wave S:**
1. Any migration-bearing PR (currently just #1727, migration 0368) follows the
   same serial + agents.md-verify discipline as Wave M, appended to the
   `migration_plan.order` in `rc-2026-08-launch-72h.json` in ascending numeric
   order relative to the RTE table (0367 → 0368 → 0369 → ... → 0374).
2. Shared-file PRs (anything touching `copy.ts`, `ci.yml`, or a shared
   `agents.md`) — resolve-then-merge serially, or batch as their own
   sub-RC, per `release-management-runbook.md` §6.3.
3. Everything else can merge in any order once green + evidenced — Mergify's
   `batch_size: 10` (see §3) naturally paces this.

---

## 2. `covered_main_shas` maintenance rule

Every time a Mergify batch lands (landing = the batch's PRs are actually
merged, not just queued), append the new `main` tip SHA to **both**
`allowed_base_shas` and `covered_main_shas` in
`rc-2026-08-launch-72h.json`. Do not remove old SHAs — a PR still soaking
against an older base needs its base covered until it's re-based or merges.

For a wave this size (~40 PRs, `batch_size: 10` per §3), expect roughly **4
checkpoints**:
1. After Wave G lands (3 PRs, likely one batch).
2. After Wave M's third PR (#1652) lands (serial, so this is really 3
   individual checkpoints compressed into "after M completes" for manifest
   purposes — append after M1, M2, AND M3 individually, since each is a serial
   merge event, not a batch).
3. After Wave D + Wave F land (likely one combined batch, ~3 PRs).
4. After each ~10-PR Wave-S batch (multiple checkpoints for a 40-PR wave).

**Procedure:**
```bash
git fetch origin main
git log -1 --format='%H' origin/main
# append that SHA to both arrays in rc-2026-08-launch-72h.json,
# per the manifest's own _append_procedure item 2
```

Do this **every time**, not just at the end — a manifest whose
`covered_main_shas` lags reality fails the gate's `rcCurrentBaseCovered` check
for any PR still trying to cite it (`scripts/ci/check-staging-evidence.ts`).

---

## 3. Mergify discipline notes

- **`batch_size: 10`.** Do not manually force a larger batch through the
  queue — the batch size is a deliberate throttle, not a bug to work around.
- **Never push to or edit a PR while it's in the Mergify queue.** Check it
  isn't queued before touching it — a push resets queue progress and
  re-runs speculative checks (pure churn,
  `memory/feedback_dont_churn_mergify_queue.md`). Dequeue deliberately if a
  change is truly needed.
- **`@mergifyio refresh` doesn't reliably force embark.** Post it, then
  verify `queued` actually appears in the PR's Mergify status comment/check
  before assuming anything changed (`memory/project_mergify_refresh_to_embark.md`).
  A clean, green PR often won't auto-embark on its own.
- **A CANCELLED check on a queued (or recently-queued) PR is very likely a
  superseded speculative run**, not a real failure — leave it alone rather
  than re-triggering (`memory/feedback_dont_churn_mergify_queue.md`). Several
  PRs in this wave's inventory show exactly this pattern (`Staging Soak
  Evidence Gate: CANCELLED` alongside a separate `FAILURE` entry, e.g.
  #1721, #1716, #1618) — don't treat the CANCELLED line as an additional
  distinct failure.
- **Finalize the evidence body before queueing.** A body edit after queueing
  auto-dequeues the PR as "manually updated"
  (`release-management-runbook.md` §6.5). Fill in the `RC manifest path:`
  line and confirm the manifest itself is `approved` **before** the PR enters
  the queue, not after.
- **Stacked PRs merge base → delete branch → child**, never manual `--base`
  retarget (`memory/feedback_stacked_pr_retarget_drops_ci.md`). None of the
  current inventory is explicitly stacked, but Wave-S PRs opening later may
  be — check `baseRefName` per PR before assuming flat structure.
- **Claude never runs `gh pr merge` / `gh pr ready` on a soak-tier PR** — the
  `block-pr-merge.sh` hook hard-blocks it. T1/T2/T3 readiness is Carson's
  flip. The RM's job stops at "mergeable and provably safe," then hands off.

---

## 4. `agents.md` post-merge verification procedure (§2 step 5, detail)

For every merge that touches a shared `agents.md` (which, per the union merge
driver, auto-resolves rather than conflicts — meaning it can silently drop
content instead of failing loudly):

```bash
git fetch origin main
git show origin/main:supabase/migrations/agents.md | tail -50
# confirm the section this PR was supposed to add is actually present,
# not silently unioned-away or truncated
```

Repeat for every `agents.md` path the merged PR touched (check via
`gh pr diff <N> --name-only | grep agents.md` before merging so you know what
to verify after). If content is missing, this is the exact failure mode
`CLAUDE.md` §6 already logged an incident for (#1031 behind #1022) — do not
assume a "config fix" makes this check skippable; verify anyway, every time,
for this wave.

---

_Last refreshed: 2026-07-28 by Release Manager agent (SCRUM-2980 companion draft) — PR inventory, base SHAs, and CI status verified live via `gh pr list`/`gh pr view` against `main` at `ae2209fd771ff088d8f3ef12070f4028cbd421a7`. Wave-S content is necessarily incomplete — new PRs were opening during this session. Re-verify before executing any wave._

---

## Sprint-S collision map (CTO, 2026-07-28) — VERIFIED BY REAL MERGE TESTS

Empirical `git merge --no-commit` runs in scratch worktrees, not `merge-tree` guesses. **A named human owner must execute these unions. Do NOT let "whichever lands last" resolve them.**

### MANDATORY LAND ORDER
`#1735 → #1736 → #1737 → #1738 → #1740` (#1732 has zero collisions, lands any time.)

### Collision 1 — `src/lib/ocrWorker.ts` is THREE-way (#1735, #1736, #1740)
All three edit the same `extractText()` dispatcher, the `OCRResult.method` union, and adjacent format constants.
**The dangerous one is #1740**, because it does not merely add a branch — it DELETES the SCRUM-2911 blanket TIFF/HEIC soft-fail (`isUnsupportedImageFile` / `UNSUPPORTED_IMAGE_TYPES` / `UNSUPPORTED_IMAGE_EXTENSIONS`) and replaces it with real decode. #1735/#1736 still carry that block. Verified: after merging #1735→#1740 the definitions vanish (correct 3-way behavior) while #1735's **call site** survives inside the conflict markers — so accepting "ours" at that hunk yields a file that references a deleted function.
**Required union:**
- `OCRResult.method` = `'pdfjs' | 'pdfjs-ocr' | 'tesseract' | 'mammoth' | 'text' | 'zip-xml' | 'rtf' | 'svg' | 'spreadsheet'`
- Dispatcher order: DOCX → RTF(#1735) → SVG(#1735) → ZIP-XML(#1735) → Spreadsheet(#1736) → **#1740's real `isTiffFile(file) || isHeicFile(file)` decode branch** (the `isUnsupportedImageFile` soft-fail block MUST be deleted) → `image/*` → text.
- `vite.config.ts` `manualChunks`: keep `vendor-zip`(#1735) AND `vendor-tiff`/`vendor-heic`/`vendor-png-encode`(#1740).
- SVG branch MUST stay before the generic `image/*` branch, or `image/svg+xml` falls into Tesseract.
TypeScript catches a wrong union (extractors won't type-check), so failure mode is CI-red, not silent.
**Owner: #1740's author performs the final union rebase** (most context on what superseded what).

### Collision 2 — `src/components/anchor/FileUpload.tsx` (#1736 vs #1738) — SILENT REGRESSION RISK
Both renamed the shared dispatch fn (`dispatchFiles` #1736 vs `handleFilesDetected` #1738) with **semantically different single-spreadsheet behavior**. #1736 pauses on the mode-choice step (`setPendingModeFile`); #1738 (branched earlier, unaware) routes a lone spreadsheet straight to `onBulkDetected` — the exact bug #1736 exists to fix.
**Taking #1738's block silently reverts the founder-P0 spreadsheet-as-document deliverable. Both versions compile — there is NO compile error to catch this.**
**Required union:** multi-file path takes #1738's all-spreadsheet-vs-mixed check (`onBulkDetected` vs `onMixedBatchDetected`); single-spreadsheet path takes #1736's `setPendingModeFile`, never `onBulkDetected`.
**Land #1736 BEFORE #1738; #1738 rebases onto it.**

### Post-merge verification (mandatory)
After BOTH collisions resolve, confirm by behavior not by clean exit: (a) a lone `.xlsx` drop still reaches the mode-choice step; (b) a mixed multi-file drop reaches `onMixedBatchDetected`; (c) TIFF/HEIC take the real decode path and `isUnsupportedImageFile` no longer exists anywhere; (d) `grep -a` for `isUnsupportedImageFile` returns zero hits.
