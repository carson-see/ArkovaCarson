---
name: session-bootstrap
description: Arkova session start-up sequence — the mandatory read order, the CLAUDE.md hash acknowledgment that unblocks staging/prod commands, lane self-routing, checking for active soaks before touching anything, and verifying the Atlassian connector is actually authenticated. Use at the start of any Arkova session, after context compaction, after a session or worktree restart, and whenever a bootstrap hook blocks a command.
---

# Session bootstrap

## 1. Read, in order

1. `CLAUDE.md` — the rules.
2. `HANDOFF.md` — current state, open blockers, and **ACTIVE SOAKS**.
3. `docs/operating-model/lane-manifest.yaml` — your lane, RACI, merge policy.
4. `docs/operating-model/session-operating-model.md` — bootstrap + SDLC self-route.
5. `agents.md` in any folder you are about to edit.
6. The sprint doc's lane block, plus the Jira ticket if the task references one.

## 2. Acknowledge the constitution hash

```bash
./scripts/agent/ack-claude-bootstrap.sh
```

Until this matches the current `CLAUDE.md` hash, `.claude/hooks/check-claude-bootstrap.sh` **denies** staging/prod-sensitive Bash: `scripts/staging/*`, `supabase db push --linked`, `db reset`, `migration repair`, `supabase link`, `gcloud run deploy|services update|jobs execute`, `gh pr ready`, `gh pr merge`, and `gh pr edit --body`.

Re-run it after CLAUDE.md changes, after context compaction, and after any session or worktree restart. If a command is blocked, the fix is to re-read the relevant sections and re-ack — never to work around the hook.

## 3. Check for active soaks before touching anything

A soaking PR is **frozen evidence**. Do not push to it, redeploy it, mutate its rig, or merge it. A Cloud Run service sitting on a non-tip SHA is an in-flight soak, not an orphan. Read the HANDOFF "active soaks" block first and confirm the clock state before any deploy or rig write.

Never use a live soak rig as a validation target for an unrelated fix.

## 4. Self-route to one lane

One lane per session (Sprint 0 is the train-led exception). Execute only your lane's surfaces per the lane manifest — a cross-lane change is a handoff, not a reach-in.

## 5. Verify the tooling you are about to rely on

- **Atlassian connector.** Jira and Confluence are the sources of truth for status and documentation. In a non-interactive or headless session the connector may be unauthenticated, which silently severs that loop. Confirm access before asserting anything about ticket state; if it is unavailable, say so rather than reasoning from the repo alone.
- **Worktree isolation.** If other sessions or agents may be active, work in your own `git worktree`, not the shared checkout. A concurrent session running a rebase or `git stash` in the shared tree will silently revert your uncommitted edits.
- **Branch check after resume.** Run `git branch --show-current` before committing. Context resume does not guarantee you are where you left off.

## 6. Know what you may not do

- **Never merge.** `gh pr merge` is hard-blocked by `.claude/hooks/block-pr-merge.sh`. Mergify merges every tier once CI is green and the Staging Soak Evidence Gate passes.
- **Never work directly on `main`** for code, migrations, RLS, CI scripts, workflows, or CLAUDE.md rule changes. Pure documentation changes may land directly on `main` per the §0 rule 8 carve-out.
- **Never assert prod state from code, a PR body, or a doc.** Query it (gcloud, MCP, `/health`) and cite the artifact.

## Related

`memory/feedback_verify_branch_after_resume.md`, `memory/feedback_dont_touch_soaking_prs.md`, `memory/feedback_no_live_soak_rig_as_validation_target.md`, `memory/feedback_assert_prod_state_directly.md`, `memory/feedback_worktree_isolate_code_agents.md`.
