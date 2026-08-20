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
- **`secdef-function-grants.ts`** — every `public` SECURITY DEFINER function must explicitly `REVOKE ... FROM PUBLIC, anon, authenticated` in the migration that defines it. `REVOKE ... FROM PUBLIC` alone does NOT remove the direct EXECUTE grants `ALTER DEFAULT PRIVILEGES` gives `anon`/`authenticated` at CREATE time, so the function stays an anon-reachable RLS-bypassing RPC. Five occurrences (0364, 0377, 0378, 0388, 0406). Ratchet against `secdef-grants-baseline.json` (burn-down; may only shrink — a stale entry fails, enforced in BOTH `run()` and the test). Deliberately-public functions are listed in `DELIBERATELY_PUBLIC` in the rule. Override: `secdef-grants-skip` label. **Merge-time enforcement is `secdef-function-grants.test.ts` (runs in `Tests`), because `Policy Lints` is not one of Mergify's merge conditions.**
  **POSITION, not just presence** (added after a review of the original rule found two ways to pass while still shipping the hole): the revoke must come AFTER the function's LAST `CREATE OR REPLACE` — one written above the definition, or a re-definition written below the revoke, is undone by `CREATE OR REPLACE` re-running `ALTER DEFAULT PRIVILEGES` — and no later `GRANT` on that function may hand EXECUTE back to `anon`/`authenticated`. All scans share one `prepare()` (comments stripped, whitespace collapsed, dollar-quoted bodies blanked) so the offsets being compared are in the same index space.

- **`surrogate-safe-truncate.ts`** — no bare `.slice(0, N)` / `.substring(0, N)` / `.substr(0, N)` inside a `.insert(`/`.update(`/`.upsert(` argument span in `services/worker/src` (non-test). A code-unit cut can split a surrogate pair; the lone high surrogate makes the whole PostgREST body invalid JSON (`PGRST102`) — the 2026-08-17 poison-record mechanism (PR #2266). Fix: `services/worker/src/utils/utf16-truncate.ts` `truncateUtf16Safe`. Ratchet against `surrogate-truncate-baseline.json` (burn-down; may only shrink — a stale entry fails, enforced in BOTH `run()` and the test). Lexical single-file check by design: variable/helper-mediated flows (the `sanitizeLastError` shape) are covered by their own poison tests, not this scan. `createHash()/createHmac().update()` receivers exempt. Override: `surrogate-slice-reviewed` label. **Merge-time enforcement is `surrogate-safe-truncate.test.ts` (runs in `Tests`), because `Policy Lints` is not one of Mergify's merge conditions.**

## Conventions
- Each script imports shared helpers from `../lib/ciContext.ts`.
- Exit 0 = pass; exit 1 = fail with (a) what failed, (b) why, (c) how to fix/override.
- Override labels are defined in `../lib/ciContext.ts` `LABELS` export.
