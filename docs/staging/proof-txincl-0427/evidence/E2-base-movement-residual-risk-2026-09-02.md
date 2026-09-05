# E2 — PR #2524 base movement after the R1 rig was built (residual-risk note)

**Finding.** The R1 isolated rig (`arkova-worker-proof-txincl-0427-staging`, Supabase `uqobkjhlnqmcpjidngxr`) runs the image built from `a3f1d6b36`. GitHub reports the PR head as `e5815e9ac`, a merge of `origin/main` (`4b3db0c0c`) into `a3f1d6b36`, committed 2026-09-02T12:54:02Z — 44 minutes before the soak window opened (13:38:43Z). The rig was therefore built from the merge's first parent, not from the PR head.

**What the merge changed.**
- PR-specific diff (head vs. its merge-base with main) before and after the merge: 5090 vs. 5098 lines; the only differences are hunk context and `index` lines in `docs/api/agents.md` and `packages/sdk/src/agents.md`. Every PR-authored code change is byte-identical.
- Main-side delta under the PR's own paths (`git diff a3f1d6b36 e5815e9ac -- <PR-owned files>`): 13 files, 289 insertions, 17 deletions — twelve `agents.md`/docs files plus one runtime file, `services/worker/src/routes/cron.ts`:
  ```
  -  keyGenerator: () => 'cron-jobs',
  +  scope: 'cron-jobs',
  +  keyGenerator: () => 'global', // one bucket for all cron callers
  ```
  This is the rate-limiter bucket key for the `/jobs/*` routes, contributed by a PR already merged to main with its own evidence. It does not touch the populate job, the proof reader, `confirmation-proof.ts`, migration 0427, or the tx-inclusion branch/fold logic under test.
- Overall main-side delta: 232 files (already-merged PRs; `DEPLOY_WORKER_PAUSED=true`, so none of it is in prod yet either).

**Decision (CTO, 2026-09-02).** Keep the R1 soak clock running on the `a3f1d6b36` image. The changed behavior this soak exercises is unchanged at `e5815e9ac`; the base movement is the case the RC-manifest `allowed_base_shas` / `covered_main_shas` mechanism exists for. The Staging Soak Evidence block on #2524 must state the soaked image SHA (`a3f1d6b36`) separately from the PR head SHA (`e5815e9ac`), cite this note, and list `4b3db0c0c` as the covered main SHA. If any further commit lands on the PR branch that touches a runtime or tested file, this note is void and the rig must be rebuilt.

**Verification commands** (run from a checkout with both SHAs fetched):
```
git diff $(git merge-base a3f1d6b36 origin/main) a3f1d6b36 > old.diff
git diff $(git merge-base e5815e9ac origin/main) e5815e9ac > new.diff
diff old.diff new.diff            # context/index lines in two agents.md files only
git diff --stat a3f1d6b36 e5815e9ac -- $(git diff --name-only 4b3db0c0c e5815e9ac)
git diff a3f1d6b36 e5815e9ac -- services/worker/src/routes/cron.ts
```
