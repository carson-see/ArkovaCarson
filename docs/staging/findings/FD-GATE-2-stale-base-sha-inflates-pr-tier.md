# FD-GATE-2 — the evidence gate attributes `main`'s commits to a stale PR, inflating its required tier

**Found:** 2026-08-21, preparing the T0/T1 backlog. Independently reproduced.
**Severity:** high, systemic. Silently mis-tiers **every** PR that sits while `main` moves — which is every PR in a backlog.
**Status:** OPEN. Workaround known and applied; the gate itself is unfixed.

## The mechanism

Two pieces that are each defensible alone:

1. `scripts/ci/lib/ciContext.ts:272` computes the changed set with a **two-dot** diff:
   ```ts
   const args = ['diff', '--name-only', '--diff-filter=AMR', `${base}..HEAD`];
   ```
   Its own comment states the intent: *"Two-dot (`base..HEAD`) = the changeset of THIS PR vs the
   **current base tip**, NOT three-dot."* Correct — **if** `base` really is the current base tip.

2. `.github/workflows/staging-evidence.yml` checks out the live merge ref (`:152`) but passes
   `BASE_REF_SHA` from GitHub's `pull_request.base.sha` (`:102` → `:172`).

**`pull_request.base.sha` is not the current base tip.** GitHub freezes it at the base branch's
tip *as of the last push to the PR head*. So for any PR whose head has not been pushed recently,
two-dot from that frozen sha sweeps in **every commit `main` has taken since** and attributes them
to the PR.

## Consequence: wrong tier, and the PR is told to prove something that is not its change

Tier is computed from the changed-file set. Inflate the set, inflate the tier.

Concretely, on **#2215** (a seed-fixture PR):

| | files | computed tier |
|---|---|---|
| stale frozen base | **77** | **T2** — `.github/workflows/deploy-worker.yml — worker deploy config` |
| true changeset | **17** | **T1** |

The file that forced T2 is not in that PR. `main` changed `deploy-worker.yml` on 2026-08-20
(`7c008262`), inside the drift window, and that path hits a T2 rule. Every stale PR in the backlog
was being told to produce 12-hour soak evidence for `main`'s commits.

This is the same root cause as the earlier "#2302 mystery", where 5 real files presented as 23.

**It compounds with backlog age and with `main` velocity.** Worth stating plainly: heavy
documentation activity on `main` — including this session's own finding write-ups — widens the
window for every open PR. A quiet `main` hides this bug; a busy one exposes it everywhere.

## Workaround (applied)

**Merge `origin/main` into the PR branch.** That pushes the head, which makes GitHub recompute
`base.sha` to `main`'s tip, collapsing the drift to zero. Verified: #2215's `base.sha` moved
`b6cfad73` → `224cef8a` and the gate's file count went **77 → 17**.

Do **not** rebase/force-push to achieve this — a hook blocks force-pushes, and on a *soaked* PR a
rebase would also destroy exact-head evidence.

## The real fix, not yet made

Resolve the base at run time instead of trusting the frozen event payload — e.g. use the
merge-base of the live base branch and the head (`git merge-base origin/$BASE_REF HEAD`), or diff
three-dot against the live base ref. `fetch-depth: 0` is already set, so the history is present.
Whatever is chosen must keep the property the two-dot comment is protecting: a PR is judged on
*its own* changeset, never on what the base branch did afterwards.

Until then, **a red tier-under-declaration error on an old PR should be treated as suspect**, not
as a genuine finding, until the base drift is checked:

```
git fetch origin main
git diff --name-only $(git merge-base origin/main <head>) <head>   # truth
git diff --name-only origin/main <head>                            # what the gate may see
```
If those differ materially, the tier error is an artifact.

## The caution that still applies

This does **not** license mass-rebasing the backlog on the theory that every gate failure is drift.
Most gate failures are genuine evidence gaps. Three of the eight PRs handled in this batch were
additionally `DIRTY` — real merge conflicts with `main` that would have blocked them regardless.
Diagnose per PR with the commands above before concluding drift.
