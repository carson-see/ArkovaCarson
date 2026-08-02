---
name: never-merge-without-ok
description: Claude never runs `gh pr merge`, ever — hook-blocked. Merges land through Mergify, which auto-merges EVERY tier once CI is green and the Staging Soak Evidence Gate passes. `needs-carson-merge` is an informational tier-marker, not a queue gate.
type: feedback
---

Claude does not merge to `main`. Not T0, not a one-line doc fix, not "CI is green and it's obviously fine." The merge button is not an agent affordance.

That is **not** the same as saying a human must click merge. Current policy (CLAUDE.md §1.13, amended 2026-06-24):

- **Mergify auto-merges every tier** once CI is green and the `Staging Soak Evidence Gate` passes. T0/T1 move fast; T2/T3 queue only after merge-grade soak evidence.
- The real tier gate is the **evidence requirement**, not a manual merge.
- **`needs-carson-merge` is an informational tier-marker, not a queue gate.** `.github/workflows/merge-authority.yml` still applies it to T2/T3 PRs, but the S0-4.2d condition that held those PRs out of the Mergify queue was removed from `.mergify.yml` on 2026-06-24.
- **Carson overrides any PR at any time** with `do-not-merge` or `work-in-progress` (both are queue-blocking conditions in `.mergify.yml`), and retains final admin-merge authority.

Do not write or act on the superseded version of this rule — "T2/T3 are Carson's to merge manually" is no longer policy.

**Why:** Two costs, pulling in opposite directions. Agent-driven merges bypassed the evidence gate and put unsoaked changes on `main`; a merge is the one action with no undo that matters. But the earlier fix — routing T2/T3 through a manual merge — made Carson the throughput bottleneck for changes whose actual safety came from 12h/48h soak evidence, not from who pressed the button. The gate belongs on the evidence, and the block belongs on the agent.

**How to apply:**
- Get the PR to green + evidence-complete, then `gh pr ready` it. Marking a verified PR Ready is not a merge and is expected of you — but a T1/T2/T3 PR is only ready after a real soak and a real pre-mortem, never as a formality.
- Then stop. Mergify embarks it. Do not poll-and-merge, do not `gh api -X PUT /pulls/N/merge`, do not ask for merge permission as a workaround.
- Do not push to a PR that is already in the queue — it resets queue progress and re-runs speculative checks (CLAUDE.md §6). Dequeue deliberately if a change is genuinely needed.
- A CLEAN PR that will not embark sometimes needs a `@mergify refresh` comment to re-evaluate. *(Sourced from operator memory, not from a repo artifact — verify before relying on it.)*

**Enforcement:** `.claude/hooks/block-pr-merge.sh` — a PreToolUse hook on Bash, version-controlled in the repo since 2026-08-01 (it previously lived only at `~/.claude/`, so protection depended on which machine the session ran on). Exit 2 blocks: `gh pr merge`, raw `gh api -X PUT|POST .../pulls/N/merge`, force-push to `main`/`master`, and `--no-verify`. Queue policy lives in `.mergify.yml`; the evidence gate is `scripts/ci/check-staging-evidence.ts`.

**Carve-out:** `carson-see/arkova-marketing` — a static Vercel marketing site with no staging rig. The hook exempts `gh pr merge` commands that explicitly name that repo (operator-authorized 2026-07-02). The app repo and all force-push / `--no-verify` rules stay fully enforced.

**Note:** `memory/README.md` previously mapped this rule to "Atlassian Automation R5". R5 in `docs/jira-workflow/automation-rules.json` is "Block Done on red required check" — a Jira Done-transition gate, unrelated to merging. Merge enforcement is the hook plus Mergify.

See also: `feedback_merges_go_through_mergify.md`.
