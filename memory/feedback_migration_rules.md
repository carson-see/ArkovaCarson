---
name: migration-rules
description: Migration file rules — NNNN_name.sql naming, never `supabase migration new`, a runnable `-- ROLLBACK:` inverse, never modify an applied migration, and never push migrations straight to prod.
type: feedback
---

A migration is the one artifact in this repo that cannot be fixed by editing it: once it has run somewhere, the only correct repair is another migration.

**Rules:**

1. **Name it `supabase/migrations/NNNN_snake_case_name.sql`.** Four-digit numeric prefix. Pick the number per `memory/feedback_migration_number_vs_reservations.md`.
2. **Do not run `supabase migration new`.** It generates a 14-digit timestamp prefix, which does not match the numeric ledger the drift gate keys on. Create the file directly.
3. **Every migration carries a runnable `-- ROLLBACK:` comment** — the actual inverse DDL, valid as written, not a description of it. "Rollback: drop the column" is not a rollback; `-- ROLLBACK: ALTER TABLE t DROP COLUMN c;` is.
4. **Never modify an existing migration.** It has already run wherever it was applied, so editing it silently diverges environments. Write a compensating migration.
5. **Never apply a migration directly to prod ahead of its PR.** Migrations are T3: 48h soak, multiple trigger cycles, clean-mirror or isolated staging. Applying to prod first creates an orphan ledger row that fails the migration-drift gate repo-wide — every open PR goes red at once, not just yours.
6. **Regenerate types and update the seed** after the schema changes (`npm run gen:types`, `npx supabase db reset --local`).

**Why:** each rule maps to a specific outage or stall this repo has actually had. Timestamp-prefixed files desync the numeric ledger. A missing rollback turns a bad migration into an incident with no exit. Editing an applied migration means staging and prod silently stop matching, and nothing reports it. A prod-applied orphan row breaks *every* queued PR, which reads as "CI is broken" rather than "one PR did something".

**How to apply:**

- Boilerplate:
  ```sql
  -- NNNN_add_widget_flag.sql
  -- ROLLBACK: ALTER TABLE widgets DROP COLUMN is_active;
  ALTER TABLE widgets ADD COLUMN is_active boolean NOT NULL DEFAULT false;
  ```
- Test locally with `npx supabase db reset --local` before pushing anything.
- Apply to staging with `npx supabase db push --linked` — **not** a Supabase preview branch, which skips lettered-suffix files (`0055b_…`) and fails with `MIGRATIONS_FAILED`.
- After an MCP `apply_migration`, reconcile the ledger to the numeric prefix (CLAUDE.md §0 rule 10) and confirm `list_migrations` shows the numeric head **before** calling it done.
- Prod apply is the RTE's, and it happens as part of merging — not before.

**Enforcement:** `.claude/hooks/check-constitution-on-edit.sh` — **BLOCK** on editing an existing migration, a colliding `NNNN`, or a new migration with no `-- ROLLBACK:` comment. CI additionally runs the migration-drift gate against the prod ledger.

The rule is broader than any one hook: it covers **every** file under `supabase/migrations/`, including the timestamp-prefixed baseline and the lettered `0055b_` family. Do not treat "the hook let me" as permission — a matcher's coverage is not the rule's scope.

**Override label:** none.

See also the `migration-procedure` skill for the end-to-end runbook.
