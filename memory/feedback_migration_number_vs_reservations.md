---
name: migration-number-vs-reservations
description: The next migration number is max(origin/main head, reservations in supabase/migrations/agents.md) + 1 — never just the highest file on your branch. Reserve the number in agents.md in the same commit.
type: feedback
---

Two PRs picking the same `NNNN` is the most common migration collision, and it is discovered late — at merge time, when Mergify dequeues the loser and the whole queue stalls behind it.

**Rule:** the next free number is

```
max( highest NNNN on origin/main , highest NNNN reserved in supabase/migrations/agents.md ) + 1
```

Reserve it in `supabase/migrations/agents.md` **in the same commit** that adds the file.

**Why:** the highest migration on *your* branch is not the highest migration in flight. A branch cut yesterday does not see a migration merged this morning, and neither `git log` nor `ls supabase/migrations/` sees a number that another open PR has already claimed but not yet merged. The reservation list in `agents.md` exists precisely because the filesystem cannot answer "what is taken" — only "what has landed". Skipping the reservation is what turns a private mistake into a queue-wide stall.

The failure is silent until it is expensive: both PRs are green, both look correct in isolation, and the collision only surfaces when the second one tries to merge.

**How to apply:**

```bash
git fetch origin main
# (a) highest that has landed
ls supabase/migrations/ | grep -oE '^[0-9]{4}' | sort -n | tail -1
# (b) highest that is merely reserved
grep -iE 'reserv' supabase/migrations/agents.md
```

Take `max(a, b) + 1`. If they disagree, the reservation list wins — it is ahead of `main` by design.

- Derive the ceiling by scanning **all remote branches**, not just open PRs; a pushed-but-unopened branch can hold a number too.
- Reserve in `agents.md` in the same commit. A number you took but did not publish is a number the next agent will take.
- Title the `agents.md` block `## Recent migrations (PR #NNNN)` in PR-number order rather than blindly appending at EOF — two PRs appending at EOF collide and the loser gets dequeued (CLAUDE.md §6).
- Never renumber a migration that has been applied anywhere. Write a compensating migration instead.

**Enforcement:** `.claude/hooks/check-constitution-on-edit.sh` — **BLOCK**. It refuses a `Write` to `supabase/migrations/NNNN_*.sql` when that prefix already exists on `origin/main` or in the working tree, and its deny message names this file. The same hook separately refuses any edit to an existing migration and any new migration lacking a `-- ROLLBACK:` comment.

**Override label:** none.

See also `memory/feedback_migration_rules.md` and the `migration-procedure` skill.
