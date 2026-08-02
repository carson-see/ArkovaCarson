---
name: pr-triage
description: Diagnose why an Arkova PR is not merging and what to do about it — reading the required-check set, the difference between BLOCKED and a real failure, tier under-declaration, Mergify queue behavior, the ledger-orphan failure that breaks every PR at once, and what Claude may and may not do. Use when a PR is stuck, when CI is red, when deciding what to merge next, or when a gate rejects a PR you believe is correct.
---

# PR triage

## First, know what you may do

Claude **never merges** — `gh pr merge` is hard-blocked by `.claude/hooks/block-pr-merge.sh`. Mergify auto-merges **every tier** once CI is green and the Staging Soak Evidence Gate passes; Carson can admin-merge or override with `do-not-merge` / `work-in-progress`. So triage means *unblock*, never *merge*.

Marking a verified, green PR Ready (`gh pr ready`) is expected of you — but a T1/T2/T3 PR is only ready after a real soak, never as a formality.

## `BLOCKED` usually is not a failure

`mergeStateStatus: BLOCKED` most often means a **required check is still pending**, not that anything failed. Distinguish before reacting:

```bash
gh pr checks <n> | awk -F'\t' '$2!="pass" && $2!="skipping" {print $2": "$1}'
```

The 14 required checks on `main`: TypeCheck & Lint, Tests, Generated Types Check, Migration Safety Check, Lockfile Integrity, Secret Scanning, Dependency Scanning, TDD Enforcement, TLA+ Verification, Check supabase/migrations vs prod, AI Eval Regression Gate, SonarCloud Code Analysis, E2E Tests, Staging Soak Evidence Gate. There is **no required human review**.

`Tests` and `E2E Tests` are the long poles — a green PR can sit BLOCKED for many minutes on them alone. Wait before diagnosing.

A `CANCELLED` check on a queued PR is a superseded speculative run, not a failure. Do not react to it, and do not push to a PR that is already in the Mergify queue — that resets queue progress and re-runs speculative checks. If a CLEAN PR will not embark, a `@mergify refresh` comment sometimes re-evaluates it.

## Repo-wide failures: check a second PR before debugging your own

Some gates fail across **every** open PR at once. If a check is red, run the same check on an unrelated PR before assuming your change caused it.

The recurring one is **`Check supabase/migrations vs prod`**: prod has a ledger row whose source `.sql` never landed on main (a migration applied to prod ahead of its owning PR merging). Every PR then fails identically. The fix is not in your PR — either the owning PR merges, or the prefix gets a dated entry in `scripts/ci/snapshots/ledger-numeric-exemptions.json` with a note naming the owning PR. Remove the exemption when that PR lands.

## Staging Soak Evidence Gate failures

Most are **body format**, not missing soak work. Load the `soak-evidence` skill. Quick checks: an exact `## Staging Soak Evidence` H2, and a parseable `Tier: T[0-3]` line.

If it says *"Declared tier T0 is below required tier T1"*, the path detector found a file it does not classify as docs/tests/CI/tooling. Find which:

```bash
gh pr diff <n> --name-only
```

Then decide honestly. Either the file genuinely is tooling — in which case the classifier's allowlist is wrong and fixing it is legitimate — or it is not, and the PR needs the higher tier's evidence. Do not allowlist a runtime path to dodge a tier. If you do change the classifier in the same PR it gates, say so explicitly in the body and ask for review on that specific hunk.

The gate also demands, for T1+, that the evidence names the **changed behavior** and the proof that exercised it. Generic load is worker-health evidence only.

## Tier under-declaration

The detector fails **closed to the highest tier**. Hard mappings: `supabase/migrations/**` and `services/worker/src/chain/**` are T3; public API contracts, worker behavior, queues, billing, webhooks are T2. Declaring lower than the files require fails the gate — declaring higher only costs soak time.

## Merge sequencing

- **When the worker deploy is frozen** (`DEPLOY_WORKER_PAUSED=true`), merging does not deploy. Merge risk and deploy risk decouple: landing green work on main is cheap, and the gated step moves to the deploy.
- Two PRs touching the same migration prefix, or both appending to the same `agents.md` section, will collide and the loser gets dequeued. Sequence them deliberately.
- A stacked PR retargeted after its base merges can lose its CI; prefer merging the base and deleting its branch so GitHub auto-retargets.

## Draft PRs

A PR left draft usually encodes a real reservation — an unbuilt consumer, an unmade decision, an unfinished soak. Read why before readying it. Do not undraft someone else's reservation to unblock throughput.

## Related

`.claude/skills/soak-evidence/SKILL.md`, `.claude/skills/prod-state-check/SKILL.md`, `memory/feedback_merges_go_through_mergify.md`, `memory/feedback_dont_churn_mergify_queue.md`, `memory/feedback_never_merge_without_ok.md`.
