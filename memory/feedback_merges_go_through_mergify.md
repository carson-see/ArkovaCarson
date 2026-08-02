---
name: merges-go-through-mergify
description: Mergify is the merge path for every tier. Getting a PR merged means getting it green + evidence-complete + Ready, then leaving it alone — not finding someone to click merge.
type: feedback
---

There is one merge path: the Mergify queue. It auto-merges **every** tier — T0 through T3 — once CI is green and the `Staging Soak Evidence Gate` passes (CLAUDE.md §1.13; `docs/release/release-management-runbook.md` merge-authority row).

**Why:** Treating T2/T3 as "needs a human to merge" put a person in the loop at the step where a person adds nothing. The safety of a T3 change comes from 48h of soak evidence at the exact head SHA, from clean-preflight isolation, from rollback rehearsal — all of which the evidence gate checks mechanically and a human clicking merge does not re-check. Routing those PRs to a manual merge converted a verification gate into a scheduling gate, and the queue backed up behind availability rather than behind risk. The gate now sits where the risk is: on the evidence.

**How to apply — what "merged" actually requires:**
- Not draft, no `changes-requested` reviews outstanding, no `do-not-merge` / `work-in-progress` label.
- `Staging Soak Evidence Gate` green — this is the queue-entry condition, and for T2/T3 it means real merge-grade evidence (exact PR head SHA, clean preflight, deploy log id, E2E result, rollback rehearsal).
- Merge conditions: TypeCheck & Lint, Tests, Generated Types Check, Migration Safety Check, Lockfile Integrity, Secret Scanning, Dependency Scanning, TDD Enforcement, TLA+ Verification, migrations-vs-prod, AI Eval Regression Gate, SonarCloud, E2E, and the evidence gate again.
- Then leave it alone. The default queue batches up to 10 PRs (`batch_size: 10`, widened for the Aug-10 release push); pushing to a queued PR resets batch progress and re-runs speculative checks for everything behind it.
- A `CANCELLED` check on a queued/UNSTABLE PR is usually a superseded speculative run, not a failure — read before reacting.
- `hotfix` routes to the priority queue with `allow_checks_interruption`. Use it for hotfixes, not for impatience.

**Enforcement:** `.mergify.yml` (queue rules, priority rules, merge conditions). Tier is computed by `scripts/ci/compute-merge-authority.ts` via `.github/workflows/merge-authority.yml`, which applies `needs-carson-merge` to T2/T3 as an **informational marker only** — it is not a queue condition.

**Carson's overrides:** `do-not-merge` and `work-in-progress` block queue entry on any PR; final admin-merge authority remains his.

See also: `feedback_never_merge_without_ok.md` — the agent-side hard block on `gh pr merge`.
