# FD-GATE-3 — base drift invalidates soak evidence for paths the PR never touched

**Filed:** 2026-08-22
**Severity:** High / systemic — it is the reason T3 PRs cannot land during normal merge
velocity, independent of their own quality.
**Status:** OPEN.

## The finding

The Staging Soak Evidence Gate invalidates a PR's soak evidence when **`main`** changes a
T3-classified path, even when the PR itself has never touched that path.

Verbatim, on **#2235**:

```
Base SHA drift from 785c13b0c9b0… to 406ead53a0e2… touches this PR's soak surface
(… services/worker/src/chain/fee-estimator.ts …) at T3
(services/worker/src/chain/fee-estimator.ts — chain/treasury hot path);
existing soak evidence cannot be preserved without release-owner re-scope/retest.
```

**#2235 changes 32 files and NOT ONE of them is under `services/worker/src/chain/`.** They are
webhooks, cron, compliance, admin-lists, CI scripts, docs and SDK types. `fee-estimator.ts` was
changed on `main` (`5c0db595a`, `239c430d2`, `37119efe2`). The identical message appears on
**#2314**, which also touches zero chain files.

The phrase *"this PR's soak surface"* is therefore a misnomer. What the gate actually computes is
**the set of T3-classified paths appearing anywhere in the base drift**, which is `main`'s
history, not the PR's diff.

## Why this is not FD-GATE-2

Same root cause family — a two-dot diff from GitHub's frozen `pull_request.base.sha` — but a
different and worse consequence:

| | FD-GATE-2 | FD-GATE-3 |
|---|---|---|
| Effect | **Inflates the tier** (more soak demanded) | **Invalidates existing soak evidence** |
| Fix | Merge `main` in; the diff shrinks | Merging `main` in **does not help** — it is `main`'s own commits that trip it |
| Recoverable? | Yes, one merge | Only by re-soaking, which cannot converge (below) |

Merging `main` into the branch is the documented FD-GATE-2 workaround. **It makes FD-GATE-3
worse**, because it pulls the offending T3 paths into the branch for real. Confirmed on #2314:
merging `main` moved `services/worker/src/chain/fee-estimator.ts` into its diff.

## Why re-soaking cannot converge

A T3 soak is **48 hours**. On 2026-08-22 `main` merged **8 PRs in ~75 minutes**. Any 48-hour
window will, with near-certainty, contain at least one `main` commit touching *some*
T3-classified path — chain/treasury, migrations, security, anchor lifecycle. When it does, the
evidence gathered during that window is invalidated on arrival.

That is a treadmill, not a gate: **the faster the repo merges, the less possible it is to land a
T3 change.** It is the same shape as [[FD-RC-1]] (RC manifests cannot be retrofitted) — a rule
that is individually reasonable and collectively unsatisfiable.

## What the rule is presumably trying to protect

A real concern: if `main` changed the chain hot path, a soak taken against the *old* base may no
longer represent what will run after merge. That is legitimate for a PR **whose own behaviour
interacts with that path**. The defect is that the check never asks whether it does.

## Suggested fix — and a correction to my first version of it

**My first draft of this finding said "compute it three-dot, not two-dot." That is wrong as
written, and `ciContext.ts` already says why.** The two-dot form is a deliberate, documented
choice (`scripts/ci/lib/ciContext.ts`, `changedFiles()`):

> Two-dot (`base..HEAD`) = the changeset of THIS PR vs the current base tip, NOT three-dot
> (`base...HEAD`, which re-surfaces everything reachable since the merge-base). On a rebased
> lane branch the three-dot form attributes a now-merged base commit's edits to the PR;
> two-dot does not.

That scenario is real. So **both forms are wrong, in opposite situations**, and neither is the
fix:

| branch state | `base..HEAD` (two-dot) | `base...HEAD` (three-dot) |
|---|---|---|
| **behind** a base that has moved on | main's commits appear as **reversions** → FD-GATE-2 / FD-GATE-3 | correct |
| **rebased** onto newer main, `base` stale | correct | main's commits are in the branch's ancestry → **attributed to the PR** |

The common factor is not the dot count. It is that **`BASE_REF_SHA` is a frozen ref** —
GitHub pins `pull_request.base.sha` at the base tip as of the PR's last push — and *any* diff
against a stale fixed point misattributes somebody's commits.

**The fix is to stop diffing against a frozen sha at all** and use the live merge base:

```
git merge-base origin/main HEAD     # → M
git diff --name-only M..HEAD        # equivalently: origin/main...HEAD
```

`M` is recomputed against the *current* `origin/main` on every run, so it is correct in both
rows above: it is by construction the point where this branch diverged from the `main` that
exists now. This is also exactly the file list GitHub shows under "Files changed."

Then, for the soak-surface rule specifically:

1. Compute the PR's own changed paths as above.
2. Invalidate soak evidence only when a drifted T3 path is one the PR **also** touches, or is a
   declared dependency of one — the **intersection**, not the drift alone.
3. Where a genuine cross-cutting risk exists (e.g. `main` changed the anchor lifecycle under an
   anchoring PR), demand a **named residual-risk note** rather than a full re-soak, because a
   re-soak provably cannot converge at current merge velocity.

Note that step 1 needs care in a shallow CI checkout: `merge-base` requires enough history for
both tips, so the fetch depth must cover the divergence. `getBaseRef({ required: true })`
already fails closed on an unresolvable base, and any replacement must keep that property —
a diff that silently returns `[]` makes every path-gated check PASS, which is the wrong
direction for a gate and was already fixed once here.

Until then the only escape the message itself offers is *"release-owner re-scope/retest"*,
which under CLAUDE.md §1.12 is an explicitly Carson-approved residual-risk exception. **That
approval is deliberately not assumed here** — this finding documents the mechanism so the
decision can be made with the facts, not so it can be routed around.

## Currently blocked by this

- **#2235** — non-draft, `SUCCESS=34`, carries a complete T3 evidence block. Its **only**
  substantive gate failure is this. It owns migrations **0411/0412/0413**, which are **already
  applied to production** — so this gate is holding closed the PR that would reconcile a
  prod-ahead-of-`main` ledger divergence.
- **#2314** — the FD-FERPA-1 fix for a **live** production privacy exposure. Its code is now
  verified (`rls-tests` passes, 23 files, including the non-vacuity control).

## What this finding does NOT claim

- It does **not** claim the soak requirement itself is wrong. T3 changes should soak.
- It does **not** claim #2235 or #2314 are safe to merge — only that the *reason* the gate gives
  is not about them.
- The `Check supabase/migrations vs prod` failure on both PRs is **separate** and is **not a
  merge blocker** — #2348 merged on 2026-08-22 with that check red.
