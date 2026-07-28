# Re-triggering a stale CI gate (`mint-fresh-event.sh`)

> **When a required PR check (most commonly the Staging Soak Evidence Gate)
> looks stale — passed/failed against an old PR body, an old head commit, or
> an old base — start here.**
>
> Jira: SCRUM-3026
> Workflow: `.github/workflows/staging-evidence.yml`
> Script: `scripts/ci/check-staging-evidence.ts`
> Helper: `scripts/ci/mint-fresh-event.sh`

## Why a check can go stale

Inside a GitHub Actions `pull_request` job, `github.sha` and every
`github.event.pull_request.*` field (head SHA, base SHA, body, labels) are
**frozen at the moment the triggering webhook event was delivered.** They do
not update just because the job runs again.

That matters because re-checking a PR does not always create a fresh
webhook delivery:

- GitHub UI **"Re-run jobs"** / **"Re-run failed jobs"**
- `gh run rerun <run-id>`
- A branch-protection **"re-request review"** or required-check re-request
- A Mergify re-check that re-queues the existing run instead of asking
  GitHub for a new one

Each of these replays the **same frozen event payload** the run was
originally created with. If you edited the PR body after that event fired —
or if other PRs merged in the same batch wave and moved `main` out from
under this PR's declared `Base SHA:` — the rerun still evaluates the *old*
snapshot. This is exactly what voided RC-manifest base coverage during the
2026-07-27 10-PR wave: reruns kept validating a base that had already moved.

## What was fixed (SCRUM-3026)

`.github/workflows/staging-evidence.yml` now resolves the PR's **current**
head SHA, base SHA, merge-preview SHA, and body via a `gh api` call
(`Resolve live PR state`, step id `live_pr`) at the start of every job run —
not from the frozen event payload. The checkout step pins to the
live-resolved merge-preview SHA, and the evidence-check step's `PR_BODY`,
`HEAD_REF_SHA`, and `BASE_REF_SHA` env vars are bound to that step's outputs.
This mirrors the labels-live-read fix already in place
(`scripts/ci/lib/ciContext.ts`'s `fetchLiveLabels` / `resolvePrLabels`),
which unions the frozen `PR_LABELS` seed with a live `gh api` fetch so an
override label added after the triggering event still takes effect on a
rerun.

This closes most of the staleness gap **without needing a new event at
all** — a bare rerun now re-evaluates current state. It does **not** and
cannot force GitHub to recompute `refs/pull/<N>/merge` (the merge-preview
ref) faster than GitHub's own async mergeability calculation, and it does
not create a new commit — so the checked-out *code* is still whatever the
last real push produced.

## When you still need `mint-fresh-event.sh`

Use the helper when you need GitHub to deliver an **actual new event**, not
just a fresher read of the existing one:

- You want every event-gated check (not just staging-evidence) to re-fire —
  `synchronize` retriggers the whole required-check set.
- You suspect `refs/pull/<N>/merge` itself hasn't been recomputed yet (rare,
  but possible seconds after a push) and want a clean re-trigger instead of
  guessing.
- The PR body's `PR head SHA:` evidence field is now stale relative to the
  actual branch tip and needs to be bumped (`memory/feedback_pr_head_sha_in_evidence_block.md`
  — "a new commit invalidates the body's PR head SHA; bump via `gh pr edit`").

### Usage

```
scripts/ci/mint-fresh-event.sh --pr <number> [options]

Options:
  --pr <number>        Required. The PR number to re-trigger.
  --bump-head-sha       After pushing, update the `PR head SHA:` line in the
                        PR body (via `gh pr edit`) to the new HEAD commit.
                        No-op with a warning if the body has no such line.
  --message <text>      Custom empty-commit message.
  --repo <owner/repo>   Target repo for `gh` calls (defaults to the repo
                        `gh` auto-detects from the current directory).
  --dry-run             Print what would happen; makes no commit, push, or
                        PR edit. Still validates preconditions.
```

Always dry-run first:

```sh
scripts/ci/mint-fresh-event.sh --pr 1722 --dry-run
```

Then run for real, bumping the evidence field's head SHA at the same time:

```sh
scripts/ci/mint-fresh-event.sh --pr 1722 --bump-head-sha
```

### What it does — and does not — do

- Creates a **tree-identical empty commit** (`git commit --allow-empty`) and
  pushes it to the PR's own branch. This fires a genuine `synchronize` event
  — every event-gated check re-runs against current PR state, including a
  freshly-computed merge-preview ref.
- Never force-pushes, never rewrites history, never touches your working
  tree's staged/unstaged changes (it refuses to run on a dirty tree rather
  than silently discarding your pending edits).
- Refuses to run unless the current branch matches the PR's own head branch
  (`gh pr view --json headRefName`) — this is a re-trigger tool, not a way
  to push to the wrong branch.
- Refuses to run against a closed/merged PR.
- With `--bump-head-sha`, only replaces the **value** on an existing
  `PR head SHA:` line (any markdown decoration — `- `, `**`, `*`, `_`,
  `[x]` checkboxes — is tolerated) via `gh pr edit --body-file -`. It never
  injects a `## Staging Soak Evidence` section or any other structure that
  isn't already there — if the field is missing, it warns and does nothing.
- `--dry-run` validates every precondition (branch match, PR state, clean
  tree) and prints exactly what it would do, without creating a commit,
  pushing, or editing the PR.

### Sanctioned use, not a gate bypass

This script only changes the **event history GitHub sees**; it never changes
what the gate requires. A T2/T3 PR still needs real soak evidence with the
correct current head SHA — `mint-fresh-event.sh` just makes sure the gate is
actually looking at that current state instead of a stale rerun snapshot.
Per CLAUDE.md §1.11, there is no override label; this tool does not create
one.

## Tests

- `scripts/ci/staging-evidence-workflow-contract.test.ts` pins the workflow
  shape (live-fetch step exists and runs before checkout; checkout pins the
  live-resolved SHA; the evidence-check step's `PR_BODY` / `HEAD_REF_SHA` /
  `BASE_REF_SHA` bind to `steps.live_pr.outputs.*`, never a raw
  `github.event.pull_request.*` value).
- `scripts/ci/mint-fresh-event.test.sh` is a stubbed (`git`/`gh` faked, no
  network) smoke-test suite covering argument validation, dry-run, the
  precondition guards (dirty tree, branch mismatch, non-open PR), a plain
  run, and the `--bump-head-sha` substitution (including the no-matching-line
  no-op case). Run it directly: `./scripts/ci/mint-fresh-event.test.sh`.
