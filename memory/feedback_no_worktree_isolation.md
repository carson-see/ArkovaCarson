---
name: no-worktree-isolation
description: PR head branches must not be named as worktree paths (`.claude/worktrees/...`, `worktree/...`, anything containing `worktree`). Push from a normally-named branch. This governs BRANCH NAMES, not whether you may use a local git worktree.
type: feedback
---

A PR's head ref must be a plain branch name (`lane2/scrum-2940-folders-ui`, `fix/limiter-shadow`). CI rejects any head ref that looks like an agent worktree path.

**Why:** Worktree-path branch names make parallel sessions indistinguishable. When several agents are working the same checkout — which is routinely the case here; HANDOFF.md records this checkout as "confirmed actively shared with at least one other concurrent session", and a hygiene sweep counted **291 git worktrees whose directory names did not match their branch names** — a head ref carrying a worktree path tells you which scratch directory produced the commit, not which lane or story owns it. Reviewers, the tier detector, and soak evidence all key off branch identity.

**How to apply:**
- Name the branch after the lane and the story: `lane<N>/scrum-<id>-<slug>`, `fix/<slug>`, `chore/<slug>`.
- **Using a local git worktree is not what this rule bans.** Isolating a parallel code agent in its own worktree is normal practice here; the rule is that the branch it pushes must not be *named* like one. Create the worktree with an explicit clean branch name (`git worktree add ../wt-x -b lane2/scrum-1234-thing`) and the rule never fires.
- If CI trips on this, rename the branch and re-open the PR rather than force-pushing a rename onto a head that already has evidence attached to it.
- Prune stale worktrees during hygiene sweeps — the directory-name/branch-name mismatch is what makes a large worktree population hard to audit.

**Enforcement:** CI lint `scripts/ci/feedback-rules/no-worktree-isolation.ts` (R0-7 / SCRUM-1253). It reads `GITHUB_HEAD_REF` and fails when it contains `.claude/worktrees/`, starts with `worktree/`, or matches the word `worktree` anywhere. When `GITHUB_HEAD_REF` is unset it skips (local dev / push events).

**Override label:** none.
