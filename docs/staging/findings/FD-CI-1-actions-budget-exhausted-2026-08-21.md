# FD-CI-1 — GitHub Actions budget exhausted 2026-08-21 ~15:32Z: no CI job can start, repo-wide

**Found:** 2026-08-21T15:37Z, while re-running checks on #2228 after a dependabot rebase.
**Severity:** blocks the entire merge pipeline. **Founder-reserved** — only Carson can raise the spending limit.
**Status when written:** OPEN. **RESOLVED 2026-08-21T15:51Z** — Carson raised the limit; a re-run of #2228's CI went 13 success / 7 in-progress instead of all-refused, confirming jobs start again. Kept as a record: the diagnostic (read the check-run annotation) is the reusable part.

## What is happening

Every GitHub Actions job in this repository now fails 2–4 seconds after being queued, with
no step output. The check-run annotation is unambiguous:

```
failure: The job was not started because an Actions budget is preventing further use.
```

This is a billing limit, not a code or configuration fault. Jobs are refused before the
runner checks out the repository, which is why all ~24 jobs of a CI run fail near-instantly
and produce no logs.

## Scope — repo-wide, not dependabot-only

| Branch / SHA | Time | Result |
|---|---|---|
| `main` @ `d63f44eb9` (#2262 merge commit) | 15:32:20Z | `Revision Drift Alert` failure |
| `main` @ `6a7c00237` (docs push) | 15:32:29Z | `CI`, `gitleaks`, `Migration Drift Check` all failure |
| `dependabot/.../hono/node-server-2.1.0` @ `b538695418` | 15:33–15:34Z | all 24 CI jobs failure in 2–4 s |

Confirmed by pulling annotations directly from `main`'s own failing CI run
(`32498149116`) — same message. So this is not a `pull_request_target` /
dependabot-secrets issue; it is account-level.

The last CI to complete normally was #2262's, which merged at approximately 15:31Z —
minutes before the limit was reached.

## Consequences

- **No PR can go green.** Every required check fails immediately, so every open PR is
  BLOCKED regardless of its actual quality.
- **Mergify cannot merge anything.** Its queue gates on CI being green, which is now
  unreachable. Merging is stopped, not slowed.
- Writing or repairing PR evidence blocks is **not useful** until this clears — the gate
  that would validate them cannot run. #2228 has a complete, verified rationale ready and
  still cannot be landed.

## What is NOT affected

The soaks. They run on local `launchd` drivers against Cloud Run rigs and Supabase — none
of that path touches GitHub Actions. The chain-pair, TRAIN-4 and migration windows continue
to accrue evidence normally, and their clocks are unaffected.

## Action

Carson: raise the GitHub Actions spending limit (Settings → Billing → Spending limits).
Nothing else unblocks it — there is no retry, label, or workflow change that recovers a
refused job.

## The rule this is a case of

An all-jobs-fail-in-seconds pattern with no step logs is an **infrastructure or billing**
signal, not a code signal. Read the check-run annotation before diagnosing the diff:
`gh api repos/<owner>/<repo>/check-runs/<job_id>/annotations`. Chasing this as a lockfile
or rebase problem would have burned the afternoon.
