# Long-running migrations runbook

**Last updated:** 2026-04-24

Supabase's connection pooler enforces a hard **statement timeout (~2 min)**
that `SET LOCAL statement_timeout = '…'` inside a migration **cannot
override**. Any migration that builds an index, adds a NOT-NULL column to a
large table, or runs a long UPDATE against millions of rows will fail the
CLI's `supabase db push` with `SQLSTATE 57014 (canceling statement due to
statement timeout)`.

## Pattern — split the migration

Move the slow DDL out of the transactional migration file and into a
"deferred index" migration that contains:

1. A header comment with the full SQL to run manually.
2. A cheap no-op `DO $$ BEGIN RAISE NOTICE 'apply manually'; END $$;`
   marker so the Supabase migration ledger still records the version.

Prior art in the repo: [`0255_deferred_slow_indexes.sql`](../../../supabase/migrations/0255_deferred_slow_indexes.sql).

## Applying the deferred SQL

1. Open Supabase Dashboard → project `vzwyaatejekddvltxyye` → **SQL
   Editor**. The dashboard editor bypasses the pooler's hard timeout.
2. Copy the SQL from the header comment of the deferred-index migration.
3. Run each `CREATE INDEX` statement one at a time. Two options:
   - **`CREATE INDEX CONCURRENTLY` (default)** — non-blocking, takes
     2-3× longer but doesn't lock the table against writes. Cannot run
     inside a `BEGIN/COMMIT` transaction.
   - **Plain `CREATE INDEX` (maintenance window only)** — takes an
     ACCESS EXCLUSIVE lock on the table for the duration of the build,
     which blocks all concurrent writes. Faster total time. Only use
     when you've paused writers (anchor worker, rules engine) for a
     maintenance window; otherwise use CONCURRENTLY.
4. After all statements complete, verify with:
   ```sql
   SELECT indexname, tablename
   FROM pg_indexes
   WHERE indexname IN (
     'anchors_unique_active_child_per_parent',
     'idx_anchors_pipeline_status',
     'idx_public_records_source_id_trgm',
     'idx_anchor_proofs_batch_id'
   );
   ```
5. Post a comment on the originating Jira story (e.g. SCRUM-1124) with
   the applied timestamp + execution duration.

## Alternative — direct psql via non-pooler connection

If you have the Supabase DB password (Settings → Database → Connection
String), you can bypass the pooler entirely:

```bash
psql "postgresql://postgres:<password>@db.vzwyaatejekddvltxyye.supabase.co:5432/postgres?sslmode=require" \
  -c "SET statement_timeout = '30min'; \
      CREATE INDEX CONCURRENTLY IF NOT EXISTS …;"
```

The direct connection has no pooler timeout.

## Known deferred indexes

Source of truth: [`supabase/migrations/0255_deferred_slow_indexes.sql`](../../../supabase/migrations/0255_deferred_slow_indexes.sql)
header comment. Any time an index is added to 0255, reflect it in that
file's comment block — do NOT list them here to avoid drift between
the runbook and the migration.

## Preventing recurrence

1. **Before committing a migration that creates an index** on a table
   with >100k rows, move the CREATE INDEX to a deferred migration.
2. **Flag migrations that ALTER TABLE … ADD COLUMN … NOT NULL** on
   large tables — these rewrite every row.
3. The CI workflow `.github/workflows/migration-drift.yml` should detect
   and warn when new migrations contain `CREATE (UNIQUE )?INDEX` on a
   known-hot table; see SCRUM-1207 for the enhancement.

## References

- Related runbook: [`docs/runbooks/migration-drift-playbook.md`](../migration-drift-playbook.md) — how to detect / classify drift (complementary to this one which is how to apply)
- [Supabase CLI db push docs](https://supabase.com/docs/reference/cli/supabase-db-push)
- [Supabase statement timeout behaviour](https://supabase.com/docs/guides/troubleshooting/statement_timeout)
- SCRUM-1182 — Migration drift incident (2026-04-24)
