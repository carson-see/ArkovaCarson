---
name: migration-procedure
description: End-to-end Supabase migration procedure for Arkova — picking the NNNN number without colliding, required file boilerplate and ROLLBACK comment, applying to staging, regenerating types, seed updates, the MCP apply_migration ledger reconciliation, and the migrations agents.md note. Use whenever creating, numbering, applying, or reconciling a database migration.
---

# Migration procedure

Migrations are **always T3** (CLAUDE.md §1.12): 48 h soak, multiple trigger cycles, and clean-mirror or isolated staging. Load the `soak-evidence` skill alongside this one.

## 1. Pick the number

The next number is `max(main head, reservations in supabase/migrations/agents.md) + 1` — **not** just the highest file on your branch. Two PRs picking the same NNNN is the single most common migration collision.

```bash
git fetch origin main -q
ls supabase/migrations/ | grep -oE '^[0-9]{4}' | sort -n | tail -1
grep -iE 'reserv' supabase/migrations/agents.md
```

Reserve your number in `supabase/migrations/agents.md` in the same commit that creates the file.

- Never run `supabase migration new` — it produces timestamp names, not the `NNNN` scheme.
- **Never modify an existing migration.** Write a compensating one.

## 2. Write the file

`supabase/migrations/NNNN_short_name.sql`, with a `-- ROLLBACK:` comment that actually reverses the change:

```sql
-- NNNN_short_name.sql
-- <one line: what this does and why>
-- ROLLBACK: <the exact inverse DDL, runnable as written>

-- ... DDL ...
```

Constitution requirements that apply inside the migration:
- RLS **and** `FORCE ROW LEVEL SECURITY` on every new table.
- `SECURITY DEFINER` functions must `SET search_path = public`.
- Prefer a single function with a DEFAULT over overloads that differ only by DEFAULT.
- Use the `get_caller_role()` helper, not `current_setting('request.jwt.claim.role', true)`.
- After any DB function change: `NOTIFY pgrst, 'reload schema';`

## 3. Apply and verify locally

```bash
npx supabase db reset --local     # full replay from scratch — catches ordering bugs
npm run gen:types                 # regenerate src/types/database.types.ts
```

Update the seed if the schema change affects seeded rows. Types are regenerated **only** by the sprint's migration owner (lane-manifest guarded surface).

## 4. Apply to staging

Use `npx supabase db push --linked`. Do **not** use a Supabase preview branch: lettered-suffix files (e.g. `0055b_...`) hit the preview-branch migration-builder regex bug and fail with `MIGRATIONS_FAILED`. See `docs/reference/STAGING_RIG.md`.

Confirm the ledger head afterward — do not assume the push landed.

## 5. Ledger reconciliation after MCP apply (CLAUDE.md §0 rule 10)

The Supabase MCP `apply_migration` records a **timestamp-style** version, but the drift gate requires the **numeric NNNN prefix**. After applying a PR-owned numeric migration via MCP, reconcile in-session:

```sql
UPDATE supabase_migrations.schema_migrations
SET version = 'NNNN'
WHERE name = '<file>' AND version !~ '^[0-9]{4}$';
```

This is the **one expected ledger write** — it is not a `migration repair`. Then confirm `list_migrations` shows the numeric head **before** declaring the migration done.

Never run `migration repair`, never delete/insert ledger rows, and never reset shared staging to make evidence look clean without explicit operator approval naming the exact operation.

## 6. Close out

- Add a `## Recent migrations (PR #NNNN)` block to `supabase/migrations/agents.md`, inserted in PR-number order — not blindly at EOF (two PRs appending at EOF collide and the loser gets dequeued from Mergify).
- Update the **Data Model** Confluence page (§4 Doc Update Matrix). The markdown file is not the documentation.
- If the change touches the anchor lifecycle, edit `machines/bitcoinAnchor.machine.ts` first and re-run `check` (TLA PreCheck) before the migration lands.

## Prod apply

Applying a soaked migration to prod is the RTE's action, via MCP, followed immediately by the §0-rule-10 numeric reconciliation. Confirm the numeric head in prod before reporting the migration as done, and assert prod state directly rather than inferring it from the PR.

## Related

`memory/feedback_migration_rules.md`, `memory/feedback_migration_number_vs_reservations.md`.
