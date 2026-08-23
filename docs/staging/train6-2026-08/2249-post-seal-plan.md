# PR #2249 — post-seal close-out plan (pre-staged 2026-08-23)

> Sequence for taking #2249 from "window sealed" to "Ready for Mergify" through
> the deferred consolidated soak manifest. Nothing here runs before
> 2026-08-23T20:33:58Z. Facts verified at pre-stage time (2026-08-23 morning):
> live head = frozen head `df0e6fa932660d783fd5ca804b4c9c1dc5395684` (unchanged —
> good), PR is DRAFT, `mergeable: UNKNOWN` (GitHub recomputes lazily; the branch
> is expected-DIRTY vs main after the 2026-08-22/23 merge wave), #2249 sits in
> the manifest's **excluded_prs** ("mid-soak … finishes its own window") and is
> NOT in `included_prs`, `DEPLOY_WORKER_PAUSED=true`, `SOAK_GATE_DISABLED=false`.

## Step 0 — at seal (2026-08-23T20:33:58Z): capture, then stop the supervisor

1. Run `~/arkova-soak/train6/close-capture.sh` (refuses early; read-only).
2. **Stop the supervisor manually.** Its end-epoch parse lacks `-u` (the recorded
   node22 guard bug), so it will keep driving load until ~2026-08-24T00:33Z:

   ```
   pkill -f arkova-soak/train6/supervisor.sh
   pkill -f train6-load-loop.sh
   pgrep -fl train6 || echo clean
   ```

   Note the kill time in the maturity record's supervisor row. Post-close cycles
   are already excluded from the roll-up (`post_close_overrun_cycles`).
3. Run `docs/staging/train6-2026-08/rollback-rehearsal.sh` (guards on close +
   capture + supervisor-stopped; creates the `rollback-main` revision, restores
   `00006-gik` at 100% when done).
4. Fill `maturity-TEMPLATE.md` -> `maturity-<closeUTC>.md` from `summary.md` +
   the rehearsal record.

## Step 1 — verify the frozen head SURVIVED the window, then merge main in

```
gh pr view 2249 --json headRefOid     # MUST still be df0e6fa93… — if not, STOP:
                                      # exact-head evidence is invalidated (§1.11A)
git fetch origin main fix/fd15-worker-uuid-batch-resilience
git checkout fix/fd15-worker-uuid-batch-resilience
git merge origin/main                 # merge commit ONLY — never rebase
```

The branch is expected-DIRTY vs main (frozen mid-soak while main took the
2026-08-22/23 wave). Conflict-resolution rules, from the wave's own precedent:

- Union-resolve `agents.md` EOF-block collisions in PR-number order; if the
  resolution touches `scripts/staging/agents.md`, recompute BOTH canonical-pin
  hashes (the `provision-isolated-rig` and `batch-drain-admission-adapter` test
  pins) or their suites go red.
- After the merge, audit and paste into the PR body:

  ```
  git rev-list df0e6fa93..HEAD --not origin/main   # must be EXACTLY the merge commit
  git diff origin/main...HEAD --stat               # own contribution vs main
  ```

  Any non-merge commit that appears is a change to the PR and must be justified
  per-file in the body (the manifest's restamp notes are the format precedent).
  The soak window is NOT re-claimed for the new head — say so explicitly.
- Push the merge. GitHub may wedge on `mergeable_state: dirty` even when
  `git merge-tree` vs live main is conflict-free — that wedge class is documented
  in the manifest notes; another conflict-free merge of origin/main clears it.

## Step 2 — manifest roster move (excluded -> included)

`docs/staging/rc-manifests/rc-deferred-2026-08-22.json` is `.json` — **not**
docs-carve-out eligible. Make the edit on its own branch + PR (T0; the wave's
roster changes merged the same way):

1. **Remove** #2249's row from `excluded_prs` (its "mid-soak … finishes its own
   window" reason is now obsolete — the window is closed and sealed).
2. **Add** to `included_prs`, following the entry shape of the existing 18:

   ```json
   {
     "number": 2249,
     "head_sha": "<the live head AFTER step 1's merge — exact-head binding>",
     "base_sha": "48bdd4faea62badc816226d3c66d3fef1e0b5284",
     "risk_tier": "T3",
     "owner": "carson@arkova.io",
     "soak_train": "TRAIN-6",
     "soak_window": "2026-08-21T20:33:58Z to 2026-08-23T20:33:58Z (48h T3, closed; window 1 at 18:54:36Z VOID per FD-SEED-1)",
     "maturity_record": "docs/staging/train6-2026-08/maturity-<closeUTC>.md",
     "ci_summary": "One malformed DB row must not DoS a whole job pass; stop over-validating DB-sourced uuids (anchor lifecycle, T3 by anchorExpirySweep.ts path rule). Soaked alone on arkova-worker-wave2-2026-08-staging window 2 (union head f0e4cfe2e…) with the defect shape itself as the fixture: every fixture id a non-RFC uuid, ~<final expired count> SECURED->EXPIRED transitions through both changed dbUuid sites, org-queue claim of the non-RFC org id at start and +24h. Post-seal merge of origin/main only; window not re-claimed for the new head; merge-grade evidence for merged main owed by the consolidated soak.",
     "rollback_note": "Single revert of the PR merge. No schema, no data backfill, no flag. Revert restores the strict-uuid validation (re-opens FD-15: one malformed row DoSes the pass). Deploy rollback rehearsed post-seal on the rig: <rehearsal record path>.",
     "migration_files": []
   }
   ```

   (`base_sha` = `target_main_sha`, accepted by `rcPrBaseCovered`; keep it in
   the same style as the other entries.)
3. **Append a dated ROSTER CHANGE note** to `notes` (cumulative, matching the
   "(6)" precedent): #2249 moved excluded->included at head `<sha>`, window-2
   evidence sealed, exclusion reason obsolete.
4. `pause_lift_obligation` is prose ("every PR this manifest admitted…") — the
   notes' PR count line, if repeated, moves 18 -> 19. Re-read the field before
   editing; do not weaken it.
5. Open the PR, let CI go green, let Mergify merge it (T0). The gate reads the
   manifest from the PR's OWN checked-out tree, so #2249 cannot go Ready until
   this roster change is ON MAIN and merged into #2249's branch (step 1 merge
   already brings main in — if the roster PR merges after, merge main again;
   window still not re-claimed).

## Step 3 — body update, cycle, ready

1. Replace #2249's `## Staging Soak Evidence` section with the filled block from
   `2249-evidence-draft.md` (Tier: T3 + `RC manifest path:` + informational
   summary). The `PR head SHA:` line must equal the manifest entry's `head_sha`.
2. Re-confirm `gh variable get DEPLOY_WORKER_PAUSED` is `true` — the deferred
   path fails closed without it, and that is correct: do NOT flip it.
3. Cycle CI so every required check evaluates the final head + body: close/reopen
   refreshes checks without changing the head. Do not push again after this.
4. `gh pr ready 2249` (the pre-merge hook runs the same gate client-side).
5. If green and not embarking, post `@mergify refresh` on the PR. Do not push to
   the branch while it is queued.

## Step 4 — teardown: DEFERRED, deliberately

`arkova-worker-wave2-2026-08-staging` + `tkciooifwxwnkoizgalp` are **shared
history** — the wave2/TRAIN-2 T2 union window and both TRAIN-6 windows ran here,
and the `supabase-*-wave2` GSM secrets are named for the rig, not for this PR.
**No teardown decision is made in this close-out.** The rig stays up with
`00006-gik` restored at 100% (the rehearsal's `rollback-main` revision remains,
traffic-less, plus the old `pr-2290` tag). Disposition belongs to the §7
infra-cost sweep / Carson: either it becomes the next soak's rig or it is deleted
with its secrets in one sweep motion. Local hygiene now: keep
`~/arkova-soak/train6/` intact (the project it opens still exists); archive
`supervisor.log` + `load-*.json` copies via the close dir (close-capture does
this); do not delete `cron.secret` while the rig lives.

## Anomaly ledger this plan inherits (report, do not bury)

- Supervisor end-epoch overrun (~4 h) from the -u-less parse — handled in step 0.
- `train6-load-loop.sh` per-cycle exit code never reflects probe failures (the
  01:11Z fail=1 cycle exited rc=0) — recorded in the maturity template's driver
  caveat; a future driver should make the choice explicit, not accidental.
- Window-1 VOID artifacts share the evidence dir — every aggregate must filter
  `servingRevision == …-00006-gik` (close-capture does).
