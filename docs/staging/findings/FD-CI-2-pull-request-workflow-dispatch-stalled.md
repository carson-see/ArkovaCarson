# FD-CI-2 — `pull_request` workflow dispatch stalled repo-wide; PR check boards look green because the checks are ABSENT

**Found:** 2026-08-21T21:32Z. **Status:** OPEN at time of writing. **Severity:** high — silently makes every PR look passing.
**Not the same as [FD-CI-1]** (Actions budget exhaustion, 15:32–15:51Z). That one failed loudly, refusing every job in 2–4 s. This one fails **silently**.

## The finding

GitHub has created **no `pull_request`-triggered workflow run for this repository since
2026-08-21T20:23:21Z**. Other event types are unaffected and kept firing throughout:

| Event | Most recent (at 21:32Z) |
|---|---|
| `schedule` | 21:23:50Z ✅ |
| `push` | 21:00:54Z ✅ |
| `dynamic` | 21:06:34Z ✅ |
| **`pull_request`** | **20:23:21Z — 69 minutes stale** |

## Why it is dangerous

`gh pr checks <n>` renders a board of whatever check-runs exist. When the required workflows
never dispatch, the board shows only the **third-party app** checks — which pass on their own
schedule — and it looks clean.

PR #2321 head `56c8ce9d8`, 8 check-runs, **zero** of them a required repo workflow:

```
SonarCloud Code Analysis: success     CodeQL: success
Supabase Preview: skipped             Vercel Preview Comments: success
Mergify Merge Protections: neutral    Analyze (actions): success
Summary: success                      Mergify Merge Queue: neutral
```

Absent: `CI`, `gitleaks`, `Staging Soak Evidence`, `Migration Drift Check`, `Merge Authority`.

**A clean board here means "the gates did not run", not "the gates passed."** Anyone glancing at
that PR would reasonably conclude it was verified. It was not.

Scope, sampled at 21:35Z — PRs whose heads predate the stall still carry their checks; anything
needing a fresh run does not:

| PR | required-workflow checks | total check-runs |
|---|---|---|
| #2241 (head predates stall) | 5 | 44 |
| #2264 | 1 | 37 |
| #2228 | 0 | 37 |
| #2295 | 0 | 6 |

(#2295 is a separate, structural case: it is stacked on another PR, and the workflows are scoped
`branches: [main, staging, develop]`, so they never run on it regardless of this incident.)

## What it is NOT — ruled out by measurement

- **Not billing.** FD-CI-1's signature was every job refused in 2–4 s with an explicit budget
  annotation. Here `push` and `schedule` runs complete successfully throughout, and the newest
  run carries no annotations.
- **Not our configuration.** No file under `.github/workflows/` or `.mergify.yml` changed on
  `main` since 19:30Z. Eight workflows still declare `pull_request` triggers, and
  `staging-evidence.yml` still reads
  `on: pull_request: types: [opened, edited, synchronize, reopened, labeled, unlabeled], branches: [main, staging, develop]`.
- **Not a queue backlog.** No run is sitting in `queued` or `waiting`.
- **Not a missing event.** #2321's branch was genuinely pushed (head `56c8ce9d8`, 21:06:26Z),
  which must produce a `synchronize` event. No run exists for that SHA. A documented
  close/reopen refresh also failed to dispatch.

That leaves an upstream GitHub-side delivery problem for this event type.

## Containment — merges are blocked, not corrupted

Mergify's queue conditions name specific checks (e.g. `Staging Soak Evidence Gate`). A check-run
that does not exist cannot satisfy `check-success`, so Mergify holds rather than merging on the
empty board — consistent with `Mergify Merge Queue: neutral` above. **Nothing unverified should
merge while this persists.** The cost is throughput, not correctness.

## What to do

1. **Do not ready or merge any PR on the strength of a green board right now.** Confirm the
   required workflows are actually present on the head first:
   ```
   gh api repos/<owner>/<repo>/commits/<headSha>/check-runs --jq '[.check_runs[].name]'
   ```
   If `CI` / `Staging Soak Evidence` are missing from that list, the PR is unverified.
2. Check GitHub's status page and the repository's Actions settings; this needs an operator.
3. When dispatch resumes, **re-run the required workflows on every PR touched after 20:23:21Z** —
   their current boards attest nothing.

## The rule this is a case of

A green check board is only evidence if the checks you care about are *on it*. Assert the
presence of the specific required gates, not the absence of red. This is the same failure shape
as [[FD-PROBE-1]] (a probe green against a route that did not exist) and [[FD-LOAD-1]] (a driver
reporting success while measuring its own rate limiter): in each case the signal was structurally
incapable of failing.
