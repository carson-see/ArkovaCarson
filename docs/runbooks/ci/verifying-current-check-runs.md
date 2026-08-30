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

### The fix: close/reopen first — an empty commit voids soak evidence

Don't rely on "Re-run" — and don't reach for an empty commit by default,
because a new commit (even a tree-identical one) mints a new head SHA, and
that has consequences for any soak evidence bound to the old one.

**First choice: close and reopen the PR.** `reopened` is one of the default
`pull_request` `types` (see case 1 above), so a close/reopen delivers a
genuine new webhook event whose payload is built from the PR's **current**
state — base/head SHAs, diff, and body are all re-captured — **without
creating a new commit**. The head SHA is unchanged, so soak evidence that
names that exact head stays valid:

```bash
gh pr close <pr> --comment "re-firing stale checks" && gh pr reopen <pr>
```

(Check the PR is not embarked in the Mergify queue first — closing
dequeues it.)

**The empty-commit alternative is tier-forked.** A tree-identical empty
commit (`git commit --allow-empty` + push) also fires a fresh `synchronize`
event, but it is a real new head SHA that was never deployed or soaked:

- **T0 (no evidence block required):** fine. Empty commit, push, done.
- **T1–T3 (evidence block names an exact head SHA):** per
  `feedback_pr_head_sha_in_evidence_block`, a new commit — empty or not —
  **invalidates** that evidence: the soak covered the old head only.
  Editing the body's `PR head SHA:` field to point at the new commit is
  *relabeling* evidence, not refreshing it, and is never authorized. The
  honest follow-ups are: **re-run the soak against the new head**, or
  attach an explicit Carson/RTE-approved residual-risk note. Prefer
  close/reopen above, which avoids the problem entirely.
- **Mid-soak:** touch nothing — no empty commit, no close/reopen, no body
  edit (`feedback_dont_touch_soaking_prs`: a soaking PR is frozen
  evidence). Re-fire checks after the soak closes.

If the workflow's staleness came from case 1 above (missing `edited` in
`types:`) rather than a rerun, a body-only edit is sufficient once the
workflow is fixed — no new event maneuver needed at all.

## Summary

| Question | Where to look |
|---|---|
| Is this check current? | `gh api .../commits/<head-sha>/check-runs`, compare `started_at` to last-push time |
| Did `edited` fire the workflow? | The workflow's `on.pull_request.types:` — must include `edited` if body edits matter |
| Did a rerun reuse an old payload? | The run's `html_url` → "Triggered via" + recorded head SHA vs current `headRefOid` |
| How do I force a clean re-evaluation? | Close/reopen the PR (fresh payload, same head SHA — soak evidence survives). Empty commit only per the tier fork above: on T1–T3 it voids the soak, so re-soak or get an approved residual-risk note — never just relabel the declared SHA |

_Runbook added 2026-07-28 (SCRUM-3030), alongside the SCRUM-3029
`migration-drift.yml` `edited`-trigger fix that motivated it._
