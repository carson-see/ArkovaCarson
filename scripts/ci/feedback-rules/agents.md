# scripts/ci/feedback-rules/agents.md

Per-rule CI enforcement scripts for `memory/feedback_*.md` rules (R0-7 / SCRUM-1253). Each script is a standalone gate that fails the build when a feedback rule is violated in changed files.

## Files
- **`no-aws.ts`** — blocks AWS SDK imports and `default('aws')` in production code. Override: `aws-intentional` label.
- **`no-credit-limits-beta.ts`** — enforces credit-limits-beta naming conventions.
- **`no-worktree-isolation.ts`** — enforces worktree isolation rules.
- **`pr-target-repo.ts`** — verifies PR targets the correct repository.
- **`feedback_dont_recommend_do.ts`** — flags "recommend" language in task output (do, don't hedge). **Advisory only** — every code path returns `ok: true`, so it reports but never fails the build. Corrected 2026-08-01; this line previously claimed it blocks.
- **`feedback_jira_user_story_format.ts`** — enforces Jira user story format conventions.
- **`feedback_local_matches_prod.ts`** — enforces local-vs-prod parity rules.
- **`secdef-function-grants.ts`** — every `public` SECURITY DEFINER function must explicitly `REVOKE ... FROM PUBLIC, anon, authenticated` in the migration that defines it. `REVOKE ... FROM PUBLIC` alone does NOT remove the direct EXECUTE grants `ALTER DEFAULT PRIVILEGES` gives `anon`/`authenticated` at CREATE time, so the function stays an anon-reachable RLS-bypassing RPC. Five occurrences (0364, 0377, 0378, 0388, 0406). Ratchet against `secdef-grants-baseline.json` (burn-down; may only shrink — a stale entry fails). Deliberately-public functions are listed in `DELIBERATELY_PUBLIC` in the rule. Override: `secdef-grants-skip` label. **Merge-time enforcement is `secdef-function-grants.test.ts` (runs in `Tests`), because `Policy Lints` is not one of Mergify's merge conditions.**

## Conventions
- Each script imports shared helpers from `../lib/ciContext.ts`.
- Exit 0 = pass; exit 1 = fail with (a) what failed, (b) why, (c) how to fix/override.
- Override labels are defined in `../lib/ciContext.ts` `LABELS` export.
