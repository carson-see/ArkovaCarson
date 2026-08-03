---
name: session-bootstrap
description: Arkova session start-up sequence — the mandatory read order, the CLAUDE.md hash acknowledgment that unblocks staging/prod commands, lane self-routing, checking for active soaks before touching anything, and verifying the Atlassian connector is actually authenticated. Use at the start of any Arkova session, after context compaction, after a session or worktree restart, and whenever a bootstrap hook blocks a command.
---

# Session bootstrap

## 1. Read, in order

1. `CLAUDE.md` — the rules.
2. `HANDOFF.md` — **`## Now` only**: current state, open blockers, and the `### Soaks` block. `## History` is ~75% of the file and is dated narrative that `## Now` supersedes; read it when you need the story behind something, not on the way in.
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

A soaking PR is **frozen evidence**. Do not push to it, redeploy it, mutate its rig, or merge it. A Cloud Run service sitting on a non-tip SHA is an in-flight soak, not an orphan.

Read the `### Soaks` block under `## Now` in HANDOFF.md and confirm the clock state before any deploy or rig write. **Do not search the file for "active soak" and act on what you find** — that string occurs in dated `## History` entries describing soaks that finished long ago, so a text search returns a stale answer that reads exactly like a current one. Only `## Now` is authoritative. A Cloud Run service still existing does not mean a soak is running.

Never use a live soak rig as a validation target for an unrelated fix.

## 4. Self-route to one lane

One lane per session (Sprint 0 is the train-led exception). Execute only your lane's surfaces per the lane manifest — a cross-lane change is a handoff, not a reach-in.

## 5. Verify the tooling you are about to rely on

- **Atlassian connector.** Jira and Confluence are the sources of truth for status and documentation. In a non-interactive or headless session the connector may be unauthenticated, which silently severs that loop. Confirm access before asserting anything about ticket state; if it is unavailable, say so rather than reasoning from the repo alone.
- **Worktree isolation.** If other sessions or agents may be active, work in your own `git worktree`, not the shared checkout. A concurrent session running a rebase or `git stash` in the shared tree will silently revert your uncommitted edits.
  - **But do not name the branch after the worktree.** `memory/feedback_no_worktree_isolation.md` is CI-enforced (`scripts/ci/feedback-rules/no-worktree-isolation.ts`) and rejects worktree-shaped **branch names** — using a worktree is fine, naming your branch `wt-…`/after the worktree path is not. Override label: `worktree-branch-exception`. This trips people who follow the isolation advice literally.
  - A fresh worktree can arrive carrying staged files that match no ref. Run `git status` before your first commit.
- **Branch check after resume.** Run `git branch --show-current` before committing. Context resume does not guarantee you are where you left off.

## 6. Know what you may not do

- **Never merge.** `gh pr merge` is hard-blocked by `.claude/hooks/block-pr-merge.sh`. Mergify merges every tier once CI is green and the Staging Soak Evidence Gate passes.
- **Never work directly on `main`** for code, migrations, RLS, CI scripts, workflows, or CLAUDE.md rule changes. Pure documentation changes may land directly on `main` per the §0 rule 8 carve-out.
- **Never assert prod state from code, a PR body, or a doc.** Query it (gcloud, MCP, `/health`) and cite the artifact.

## Related

None of this skill's rules have a standalone `memory/` file. The index is `memory/README.md`.
