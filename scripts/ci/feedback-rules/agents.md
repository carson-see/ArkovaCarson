# scripts/ci/feedback-rules/agents.md

Per-rule CI enforcement scripts for `memory/feedback_*.md` rules (R0-7 / SCRUM-1253). Each script is a standalone gate that fails the build when a feedback rule is violated in changed files.

## Files
- **`no-aws.ts`** — blocks AWS SDK imports and `default('aws')` in production code. Override: `aws-intentional` label.
- **`no-credit-limits-beta.ts`** — enforces credit-limits-beta naming conventions.
- **`no-worktree-isolation.ts`** — enforces worktree isolation rules.
- **`pr-target-repo.ts`** — verifies PR targets the correct repository.
- **`feedback_dont_recommend_do.ts`** — blocks "recommend" language in task output (do, don't hedge).
- **`feedback_jira_user_story_format.ts`** — enforces Jira user story format conventions.
- **`feedback_local_matches_prod.ts`** — enforces local-vs-prod parity rules.

## Conventions
- Each script imports shared helpers from `../lib/ciContext.ts`.
- Exit 0 = pass; exit 1 = fail with (a) what failed, (b) why, (c) how to fix/override.
- Override labels are defined in `../lib/ciContext.ts` `LABELS` export.
