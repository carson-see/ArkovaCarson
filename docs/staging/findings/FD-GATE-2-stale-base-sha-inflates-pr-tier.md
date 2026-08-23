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

---

## Update 2026-08-22 — measured at scale, and the workflow attribution above is now STALE

Re-verified from the clone against live PRs. The mechanism holds. Two things have changed since
this was written, and one of them makes the section above misleading.

### 1. `staging-evidence.yml` no longer has this bug — `ci.yml` and `merge-authority.yml` do

The mechanism section blames `staging-evidence.yml` passing `pull_request.base.sha`. **That has
been fixed.** It now live-resolves the base:

```yaml
# .github/workflows/staging-evidence.yml
DATA="$(gh api "repos/${{ github.repository }}/pulls/${PR_NUMBER}")"
BASE_SHA="$(jq -r '.base.sha // empty' <<<"${DATA}")"
...
BASE_REF_SHA: ${{ steps.live_pr.outputs.base_sha }}     # :186
```

and `scripts/ci/staging-evidence-workflow-contract.test.ts` pins that and forbids reverting to
the event payload.

**The frozen sha survives in the workflows this finding never named:**

| File | Sites |
|---|---|
| `.github/workflows/ci.yml` | **9** — lines 34, 181, 439, 446, 452, 466, 482, 491, 530 (`:439` has a `\|\| 'HEAD~1'` fallback) |
| `.github/workflows/merge-authority.yml` | `:47` |

Both are `BASE_REF_SHA: ${{ github.event.pull_request.base.sha }}`, and
`merge-authority.yml`'s checkout is `fetch-depth: 0` with **no `ref:`**, so `HEAD` is
`refs/pull/N/merge`. So the affected consumers are the **tiered-merge authority label**
(`compute-merge-authority.ts`) and the **feedback-rules scans** — not the soak gate.

### 2. The precise diagnostic, and it is not "is the PR behind main"

The inflation happens only when GitHub has **recomputed the merge ref** while the event payload
still carries an older base. The test is a one-liner:

```
git rev-parse refs/pull/<N>/merge^1     # the base the merge preview was built on
gh pr view <N> --json baseRefOid        # the base the workflow env will carry
```

**Equal → no inflation is possible.** Different → the two-dot diff charges the gap to the PR.

This is why a recently-pushed PR shows nothing: pushing fires a fresh `pull_request` event, which
resyncs the payload to the merge ref. Measured on 2026-08-22:

| PR | frozen base | merge-ref `^1` | files seen | files actually changed |
|---|---|---|---|---|
| #2235 | `406ead53a` | `406ead53a` — same | 32 | 32 |
| #2314 | `d5a84d3c3` | `d5a84d3c3` — same | 14 | 14 |
| **#2219** | `49358d607` | **`253c99996` — differs** | **162** | **6** |

#2235 and #2314 had both been pushed that day, which is exactly why they look clean. **Do not
conclude the bug is absent by sampling PRs you just pushed to** — that was the first reading
here, and it was wrong.

### 3. Scale: 15 of 28 open PRs, 54 %

Sweeping every open PR with the `merge^1 != baseRefOid` test: **15 desynced, 13 synced.**
Desynced: #2336, #2274, #2270, #2266, #2264, #2258, #2254, #2251, #2249, #2245, #2233, #2232,
#2230, #2219, #2211 — i.e. most of the sat-upon backlog, which is precisely the population this
finding predicted.

**#2219 in detail.** It changes **6** files:
`services/worker/src/api/{agents.md,partner-provisioning-router.ts,partner-provisioning-router.test.ts}`,
`services/worker/src/index.ts`, `supabase/migrations/{0410_partner_accounts.sql,agents.md}`.
`ci.yml`'s env makes the scans see **162**, adding `packages/embed/package-lock.json`,
`sdks/agents.md`, `sdks/mcp-server/src/index.test.ts` and 150-odd more that `main` authored.

A note on impact, stated honestly: **#2219's own tier does not move** — it owns a
`supabase/migrations/` file, so it is T3 on its own merits. The measurable harm is to the
**feedback-rules scans**, which are handed 156 files the PR did not write and can flag
violations in `main`'s code against this PR. Tier inflation is the predicted harm for a PR whose
own content is *below* T2; that specific case is not demonstrated here and should not be claimed
without a measured example.

### Workaround, unchanged

Push to the PR (any commit, including a `main` merge). That fires a fresh event and resyncs the
payload to the merge ref. It is a workaround, not a fix: the PR re-desyncs as soon as `main`
moves again.
