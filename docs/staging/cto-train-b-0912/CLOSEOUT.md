# Train B1 / B2 close-out (CTO release session 2026-09-12, SCRUM-5054)

Any session can seal a window. Rule set: T2 floor 4 h (CLAUDE.md §1.12 as of `bd62f6ee3`), targeted evidence primary, every probe asserts a DB delta.

## Windows
| Train | Rig (Supabase / Cloud Run) | Integration head | Revision | Window dir | Start | Floor clears |
|---|---|---|---|---|---|---|
| B2 (#2837 #2834 #2841 #2842) | `xhvasifpunswhsgfsstd` / `arkova-worker-cto-train-b-0912-staging` | `6cb68f88ef27eb3e460bc85d5ce8ec3de15c35f0` | `…-00007-lis` | `/Volumes/Extreme/offload/cto-soak-2026-09-12/train-b2/window1` | 2026-09-12T21:56:48Z | 2026-09-13T01:56:48Z |
| B1 (#2835 #2836 #2838 #2839 #2840) | `pdgfbbnrqhojiihtxycd` / `arkova-worker-cto-train-b1-0912-staging` | see HANDOFF (`85059176c…` at cut) | see HANDOFF | `/Volumes/Extreme/offload/cto-soak-2026-09-12/train-b1/window1` | see HANDOFF | start + 4 h |

## Seal procedure (per window)
1. Confirm the supervisor is alive and past the floor: `cat <window>/summary.json` (cycles_fail must be 0, or every failure explained as environment with the cycle file cited). `ps -p $(cat <window>/supervisor.pid)`.
2. Confirm revision identity held: every `cycle-*.json` has the same `revision` and `candidate_sha` (`jq -r .revision <window>/cycle-*.json | sort -u`).
3. Stop the supervisor: `kill $(cat <window>/supervisor.pid)` (and its `caffeinate` child). Do NOT delete the window dir.
4. Fill `soak.end` (= `finished_at` of the last passing cycle), `soak.result: "green"`, `evidence_links` in `docs/staging/rc-manifests/rc-train-<x>-2026-09-12.json`; set `approval_status`/`approval_actor`/`approval_time` only with Carson's approval.
5. Generate the bodies: `node scripts/staging/targeted/cto-train-b-0912/seal.mjs <window> <manifest> T2` and paste each block into its PR body's `## Staging Soak Evidence` section (labels unbolded, exactly as printed). If a PR's head moved since the soak and the delta is T0-only, the script appends `Post-soak T0 delta:`.
6. Commit to `main` (T0, direct): the manifest, `docs/staging/soak-preflight/<rig>-<date>.json` (copy of the rig's clean_mirror preflight — this is what makes the `anti-hollow-soak` job evaluate something), the window's `summary.json` + a `cycles.sha256` over the cycle files under `docs/staging/cto-train-b-0912/<train>/`, and the driver directory if not yet on main.
7. `gh pr ready <N>` for each PR (the local hook re-checks the block); Mergify merges when the gate is green. Watch `gh pr checks`.
8. After each merge: `curl https://api.arkova.ai/health` git_sha (worker deploy is path-filtered — verify, don't assume), then the prod probe for that PR's changed behaviour (release plan §B step 7).
9. Tear the rig down when its train has merged (`scripts/staging/teardown-isolated-rig.sh`, then delete the four `*-cto-train-*-staging` secrets + the `supabase-db-password-<ref>` secret; §7 sweep). Record in HANDOFF.

## Standing-rig windows (#2825 #2832 #2831)
Close times under the 24 h rule: #2825 2026-09-13T11:41:32Z; #2832/#2831 2026-09-13T14:07:00Z. Procedure is in HANDOFF `## Now` (13:13Z block, "Sunday close-out").

## Seal precondition added 2026-09-13 (FD-GATE-3, learned on Train B3)
Before step 4, for EVERY PR in the train compute the same-file overlap between the PR's own diff and main's movement since the manifest's `target_main_sha`:
```
comm -12 <(git diff --name-only $(git merge-base origin/<branch> origin/main) origin/<branch> | sort) \
         <(git diff --name-only <target_main_sha> origin/main | sort) | grep -vE '\.test\.|agents\.md|^docs/'
```
If any listed file classifies T2+ (`requiredTierFor`), the evidence cannot be attested — re-cut the train on the current main (the B1 batch merging at 07:08Z invalidated Train B3 this way). Surface-only drift (no own-file overlap) is covered by a `### Base-drift residual-risk note` that enumerates every intersecting file. Land PRs that share files as ONE train and ONE Mergify batch, and never seal a later train while an earlier batch is still queued.
