---
name: local-matches-prod
description: The migration ledger and production must describe the same schema. A table that exists only in `supabase/migrations/` — or only in prod — is drift, and it fails CI until reconciled.
type: feedback
---

Local migrations are a claim about what production looks like. When the two diverge, every downstream artifact built on the local ledger (generated types, RLS tests, seed data, soak evidence) is describing a database that does not exist.

**Why:** Two shapes of this have already cost real time. Tables created only locally — demo/seed tables that were never promoted — made local runs pass against a schema prod did not have; the `docs/uat/pr-353/UAT_REPORT.md` demo-user case is the visible tail of it, where credentials documented in `docs/reference/TESTING.md` had been stripped from prod. In the other direction, migration `0358` sat merged-in-branch but unapplied to prod, and this rule went red on PR #1552 and **stayed** red — correctly. The waiver memo (`docs/staging/1552-policy-lints-diagnosis-and-waiver-memo-2026-07-20.md`) is explicit: this was "a single, intentional, expected-red rule" that clears only when release-ops physically applies the migration to prod. A body edit cannot apply a migration, and the red must not be masked.

**How to apply:**
- After a migration is applied to prod (RTE-owned step), refresh `scripts/ci/snapshots/prod-tables.json` from Supabase MCP `list_tables` / `execute_sql`. The file is hand-maintained; its `_comment` records when and against which migration it was last resynced.
- A red on a PR that adds a `CREATE TABLE` is **expected** until prod-apply. Sequence the apply; do not reach for the skip label to make the board green.
- Genuine permanent divergence goes in the snapshot's `_known_drift` block (`in_migrations_only` / `in_prod_only`), each entry carrying a `reason`. That is an auditable allow-list, not a mute button.
- The parser reads `CREATE TABLE [IF NOT EXISTS]` targets in the `public` schema only, after stripping comments. It deliberately ignores `DROP TABLE` — a table you dropped in a later migration still counts as local. Over-reporting is the intended bias.

**Enforcement:** CI lint `scripts/ci/feedback-rules/feedback_local_matches_prod.ts` (SCRUM-1306 / R0-7-FU1). It diffs the migration-derived table set against the snapshot and **fails closed** on either-direction drift. If the snapshot file is missing it warns and passes (bootstrap only). `PROD_TABLES_FILE` overrides the snapshot path.

**Note on status:** `memory/README.md` lists this as a "stub … needs Supabase MCP". The live-MCP comparison is indeed deferred — live Supabase MCP is not available in CI — but what ships is not a no-op: the snapshot diff is real and it blocks. Treat it as enforcing.

**Override label:** `local-matches-prod-skip`. Reserve it for cases where the drift is understood and being fixed in another PR; the honest fix is a `_known_drift` entry or a prod-apply.
