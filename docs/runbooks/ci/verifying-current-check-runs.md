# Verifying Current Check Runs

> **`gh pr checks` can show a check as green while the run behind it is
> days stale relative to the PR's current head/body.** Before treating any
> check as evidence for a merge, soak-evidence claim, or Jira Done
> transition, cross-check the run's actual timestamp against the last push.
>
> Jira: SCRUM-3030
> Related: SCRUM-3029 (`.github/workflows/migration-drift.yml` `edited`
> re-fire), `docs/runbooks/migration-drift-playbook.md`

## The failure mode

`gh pr checks <pr>` renders whatever GitHub's Checks API last recorded for
each context on the PR — it does not tell you when that run started, and it
does not tell you whether the run's underlying event payload (base/head SHA,
diff, PR body) still matches the PR's current state.

Two ways this goes stale in practice:

1. **A workflow's `pull_request` trigger doesn't fire on the event that
   changed something relevant.** The default GitHub Actions `types` for
   `pull_request` is `[opened, synchronize, reopened]`. `synchronize` fires
   on a new commit — it does NOT fire on a body-only edit (bumping the PR
   head SHA reference in the description, updating a
   `## Staging Soak Evidence` block, adding an approval note). A workflow
   without `edited` in its `types:` list keeps showing its *last-code-push*
   result as current even after the body claims something new. This is
   exactly what SCRUM-3029 fixed for `migration-drift.yml` — soaked PRs
   that only got a body edit (fresh soak evidence, bumped head SHA) never
   re-fired the drift check, so `gh pr checks` kept surfacing a run from
   before the evidence existed.
2. **The check ran, but its payload was frozen before the PR moved.** See
   the rerun trap below — a naive "just click Re-run" can silently reuse an
   old `pull_request` event payload.

Either way, `gh pr checks` alone cannot tell you whether the green check in
front of you actually evaluated the PR's current head SHA / body. You have
to cross-check.

## Cross-check procedure

1. **Get the PR's actual head SHA and the time of the last push.**

   ```bash
   gh pr view <pr> --json headRefOid,updatedAt,commits \
     -q '{head: .headRefOid, updatedAt: .updatedAt}'
   ```

   For the exact last-push time (not just PR `updatedAt`, which also moves
   on label/body edits), use the head commit's own timestamp:

   ```bash
   gh api repos/{owner}/{repo}/commits/<head-sha> -q '.commit.committer.date'
   ```

2. **List the check runs actually attached to that head SHA**, not the
   PR-level rollup:

   ```bash
   gh api repos/{owner}/{repo}/commits/<head-sha>/check-runs \
     -q '.check_runs[] | {name, status, conclusion, started_at, completed_at}'
   ```

   This is the ground truth: every check run GitHub has ever recorded
   *against that exact commit SHA*. `gh pr checks` can lag or roll up
   differently; this endpoint cannot lie about which SHA a run belongs to.

3. **Compare `started_at` against the last-push time from step 1.**
   - `started_at` at or after the last push → current, trust it.
   - `started_at` well before the last push → stale. The check has not
     re-evaluated whatever changed since. Do not cite it as evidence.
   - If the workflow you're checking is `pull_request`-scoped and the
     stale gap lines up with a body-only edit (no new commit), check
     whether its `types:` list includes `edited` — the SCRUM-3029 class
     of bug.

4. **If you need a specific check by name** (e.g. `Migration Drift Check`,
   `Staging Soak Evidence Gate`), filter the same endpoint:

   ```bash
   gh api repos/{owner}/{repo}/commits/<head-sha>/check-runs \
     -q '.check_runs[] | select(.name == "Migration Drift Check")
         | {status, conclusion, started_at, html_url}'
   ```

   Open `html_url` and read the run's own "Triggered via" line — it names
   the exact event (`synchronize`, `edited`, `pull_request_target`, a
   manual rerun) and the SHA it evaluated. That is the authoritative
   answer; `gh pr checks` is a summary view on top of it.

## The frozen-event-payload rerun trap

GitHub's "Re-run jobs" / "Re-run failed jobs" button does **not** re-fetch
the current PR state. It re-executes the workflow using the **event payload
captured at the original trigger time** — the same `pull_request` JSON blob
(base SHA, head SHA, PR body, diff) that existed when the check first fired.

Consequences:

- Re-running a stale check produces a new `completed_at` timestamp (so it
  *looks* fresh in the UI) but evaluates the *old* payload — old body, old
  diff, potentially an old head SHA if force-pushes happened after the
  original run. A migration-drift or staging-evidence check rerun this way
  can pass against the wrong PR content while displaying a recent
  completion time.
- This is worse than "just stale" because a stale-but-honest run at least
  shows an old `started_at` you can catch in the cross-check above. A rerun
  refreshes `started_at`/`completed_at` too, defeating that signal unless
  you also read `html_url` → "Triggered via" (rerun events are labeled
  distinctly from the original `pull_request` trigger) or diff the run's
  recorded head SHA against the PR's current `headRefOid`.

### The fix: tree-identical empty commit + body head-SHA bump

Don't rely on "Re-run". Force a genuine new `pull_request` `synchronize`
event so the workflow captures a fresh payload:

```bash
git commit --allow-empty -m "chore: re-fire CI checks (frozen-payload rerun trap)"
git push origin <branch>
```

An empty commit is tree-identical (no file changes, no re-review surface)
but it is a real new commit SHA, so GitHub fires `synchronize` with a
current payload — base/head SHAs, diff, and (if the workflow reads it) the
current PR body are all re-captured correctly.

Then bump the PR body's head-SHA reference to match, per
`memory/feedback_pr_head_sha_in_evidence_block.md` — any evidence block
that names an exact head SHA is invalidated by a new commit, empty or not,
so the body must be updated in the same breath as the push, not left
pointing at the pre-rerun SHA.

If the workflow's staleness came from case 1 above (missing `edited` in
`types:`) rather than a rerun, a body-only edit is sufficient once the
workflow is fixed — no empty commit needed. The empty-commit fix is
specifically for forcing a fresh `synchronize` event when you cannot (or
should not, e.g. mid-soak per
`memory/feedback_dont_touch_soaking_prs.md`) rely on `edited` firing, or
when the payload is frozen for a reason `edited` won't fix (a genuine
rerun-button use).

## Summary

| Question | Where to look |
|---|---|
| Is this check current? | `gh api .../commits/<head-sha>/check-runs`, compare `started_at` to last-push time |
| Did `edited` fire the workflow? | The workflow's `on.pull_request.types:` — must include `edited` if body edits matter |
| Did a rerun reuse an old payload? | The run's `html_url` → "Triggered via" + recorded head SHA vs current `headRefOid` |
| How do I force a clean re-evaluation? | Tree-identical empty commit + push + bump the PR body's head-SHA reference |

_Runbook added 2026-07-28 (SCRUM-3030), alongside the SCRUM-3029
`migration-drift.yml` `edited`-trigger fix that motivated it._
