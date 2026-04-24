# Codex migration conventions (hard rules for every session)

**Audience:** Codex agent sessions working in the Arkova repo. Paste this whole file at the top of any new session that might touch `supabase/migrations/**`, the Supabase CLI, or prod schema.

**Last updated:** 2026-04-24

Context: on 2026-04-24 we had a production drift incident (SCRUM-1182) where 29 migrations had merged to main but never applied to prod, silently breaking every worker code path that touched `user_notifications`, `api_key_scopes`, `rule_embeddings`, `org_tier_entitlements`, and 8 other tables. Root causes were (a) mixed filename conventions between codex sessions and the repo, and (b) a silently-skipping CI check. These rules prevent recurrence.

## 1. Naming — sequential numeric only

Arkova uses sequential numeric migration filenames: `NNNN_snake_case_description.sql` where NNNN is the next unused 4-digit number.

**Do NOT** use `supabase migration new` — it creates timestamp-prefixed filenames (`20260424131335_*.sql`) which break our ledger convention and our CI drift check.

Create the file by hand:

```bash
# Find the next number
NEXT=$(ls supabase/migrations/*.sql \
  | grep -oE '/[0-9]{4}_' | tr -d '/_' \
  | sort -u | tail -1 \
  | awk '{printf "%04d", $1+1}')
echo "Next: $NEXT"
touch supabase/migrations/${NEXT}_my_feature.sql
```

If you find existing `20260418...` or similar timestamp-prefixed migrations in the repo — leave them alone, they're historical reconciliation from the drift incident. All new migrations use the numeric convention.

## 2. Never push to prod from codex

Codex does not apply migrations. Ever. Not via `supabase db push`, not via `supabase migration up`, not via `psql`, not via the Supabase MCP `apply_migration` or `execute_sql` tools.

Instead:
1. Write the migration file under the numeric convention.
2. Commit + push to a feature branch.
3. Open a PR with the migration described in the body.
4. Stop. A human (Carson) applies the migration to prod after review.

If a local Supabase dev container is running and you want to test the migration against it, use `--local` explicitly:

```bash
npx supabase db push --local
```

Never `--linked`. Never without a flag. The `--linked` default points at prod.

## 3. Every migration must include

- **Header comment**: Jira story ID + purpose
- **`-- ROLLBACK:`** block with SQL to undo. Keep it accurate — if the migration changes during review, update ROLLBACK to match.
- **`IF NOT EXISTS` / `IF EXISTS`** on all DDL (`CREATE TABLE`, `CREATE INDEX`, `DROP TABLE`, etc.) so a replay is a no-op. Note: `CREATE TYPE` has no `IF NOT EXISTS` in Postgres — wrap in `DO $$ BEGIN CREATE TYPE …; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`.
- **RLS on every new table**: `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`.
- **Explicit `CREATE POLICY`** for each access path. Don't leave a FORCE-RLS table with no policies — it becomes inaccessible.
- **`SET search_path = public`** on every `SECURITY DEFINER` function.
- **`extensions.moddatetime`** (schema-qualified), not bare `moddatetime` — Supabase installs the extension in the `extensions` schema and search_path may not include it.
- **`NOTIFY pgrst, 'reload schema';`** at the end if you added new RPCs or tables that PostgREST should expose.

## 4. Large-table indexes — use the deferred pattern

Supabase's connection pooler enforces a hard statement timeout (~2 min) that `SET LOCAL` cannot override. Any `CREATE INDEX` on a table with more than ~100k rows WILL time out via `supabase db push`.

For indexes on `anchors` (1.4M rows), `public_records`, `anchor_proofs`, or any other known-hot table:

1. **Don't put the `CREATE INDEX` in the feature migration.** Keep it out of the file entirely.
2. **Add it to `supabase/migrations/0255_deferred_slow_indexes.sql`** (or the successor numeric file — check the repo for the current deferred-indexes migration). Update the header comment with the SQL.
3. **Write the SQL with `CREATE INDEX CONCURRENTLY`** — prevents locking the table during the build.
4. **Leave a NOTE block** in your feature migration pointing at the deferred file:

```sql
-- NOTE: idx_my_table_foo moved to migration
-- 0255_deferred_slow_indexes.sql — pooler statement timeout blocks the
-- build on a 1M+ row table. Apply manually via Supabase Dashboard SQL
-- Editor. Runbook: docs/runbooks/supabase/long-running-migrations.md
```

5. **In your PR description**, call out the deferred index explicitly so the human reviewer knows to apply it via the Supabase Dashboard SQL Editor post-merge (the dashboard bypasses the pooler timeout).

Full pattern + examples at [`docs/runbooks/supabase/long-running-migrations.md`](supabase/long-running-migrations.md).

## 5. Filename collisions

Before creating a new migration, verify no existing file has the same version number:

```bash
ls supabase/migrations/${NEXT}_*.sql
```

If anything returns, you chose the wrong NEXT. Bump it. Supabase's ledger uses the leading 4-digit version as the primary key; two files with the same version silently collide at push time.

## 6. Ledger-drift recovery (you will probably not need this)

If `npx supabase migration list --linked` shows local-only or remote-only rows, STOP and flag to Carson. Do NOT run `supabase migration repair`, `supabase db pull`, or `supabase db push --include-all` to "fix" it — those commands can produce partially-applied state on prod. The 2026-04-24 incident documented in [`docs/runbooks/supabase/long-running-migrations.md`](supabase/long-running-migrations.md) is the canonical recovery path; it requires human judgment per migration.

## 7. Post-migration housekeeping

When a migration lands on prod:

1. **Regenerate types** from a clean terminal (not piped through `tee`/`| head` — these corrupt the output):
   ```bash
   npx supabase gen types typescript --linked --schema public \
     > services/worker/src/types/database.types.ts
   ```
   Do NOT redirect stderr with `2>&1` — it pastes the psql login banner into the types file and breaks TypeScript compilation.
2. **Redeploy the worker** so the code picks up new table references. Carson owns this per `memory/feedback_worker_hands_off.md`.
3. **Update the relevant Confluence page** per CLAUDE.md §4 Doc Update Matrix.
4. **Update HANDOFF.md** if the migration changes operational state (new tables, new cron, new RPC, etc.).

## 8. Migration testing

Arkova's RLS test helpers are at `src/tests/rls/helpers.ts` — use `withUser()` / `withAuth()` to exercise the new migration's RLS policies before shipping. Per CLAUDE.md §1.7, coverage on security-sensitive paths is mandatory.

## References

- [`docs/runbooks/supabase/long-running-migrations.md`](supabase/long-running-migrations.md) — how to apply deferred indexes
- [`docs/runbooks/migration-drift-playbook.md`](migration-drift-playbook.md) — detecting + classifying drift
- [`CLAUDE.md`](../../CLAUDE.md) — constitutional rules (security, testing, Jira/Confluence gates)
- [`memory/feedback_worker_hands_off.md`](../../memory/feedback_worker_hands_off.md) — why you don't redeploy
- SCRUM-1182 — migration drift incident (the one this runbook was written to prevent)
