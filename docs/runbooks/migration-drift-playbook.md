# Migration Drift Playbook

> **When the `Migration Drift Check` GitHub Action fails, start here.**
>
> Jira: [SCRUM-908 PROD-DRIFT-01](https://arkova.atlassian.net/browse/SCRUM-908)
> Confluence: [SCRUM-908 PROD-DRIFT-01](https://arkova.atlassian.net/wiki/spaces/A/pages/15106049)
> Workflow: `.github/workflows/migration-drift.yml`

## What the check does

Every push to `main` and every PR touching `supabase/migrations/**` diffs
the local migration file list against the Supabase Management API's
applied-migrations set. If any local file is missing in prod, the check
fails with the list of missing files.

Read-only: the action never applies or modifies anything.

## Why this matters

Three incidents in April 2026 had the same root cause — code in `main`
depending on an unapplied migration:

| Date | Incident |
|------|----------|
| 2026-04-11 → 04-18 | Compliance scorecard silently broken for every user |
| 2026-04-18 | AdES 503 + JWT 401 chain (BUG-2026-04-18-004/005) |
| 2026-04-19 | 11 additional drifted migrations discovered during UAT |

Without this check, the next drift incident is a matter of *when*, not *if*.

## What to do when the check fails

### 1. Read the error message

The action's output lists the missing migrations. For example:

```
Migrations missing in prod:
  - 0220_some_new_table
  - 0221_add_rpc_for_feature_x
```

### 2. Classify each missing migration

For each file in the list, ask:

- **Is it required for code already in `main`?** If yes → apply ASAP.
- **Is it a schema change + code change pair?** The migration MUST land
  before (or atomically with) the code that depends on it.
- **Is it a perf optimization?** If the table is hot and the migration
  locks it (e.g., non-concurrent index creation), apply in a
  maintenance window. Mark it exempt via the `exempt_regex` list with a
  code comment explaining why, link back to this runbook, and file a
  story to apply it properly.

### 3. Apply the migration

Preferred: **Supabase MCP `apply_migration` tool.** Gives you per-statement
error handling without needing local Supabase CLI / Docker state.

```ts
// From Claude Code:
apply_migration({
  project_id: 'vzwyaatejekddvltxyye',
  name: '0220_some_new_table',
  query: '<full SQL>'
})
```

Alternative: `supabase db push` from a fresh checkout with service-role
keys configured. Slower, more surface area.

### 4. Verify

Re-run the workflow (push a no-op commit or re-run from the Actions UI).
The check should now pass.

### 5. Log

Add a bug log entry if the drift caused a user-facing incident. See
`docs/bugs/bug_log.md` for the format.

## Exempt-list discipline

Two migrations are currently exempt:

- `0190_rls_subquery_caching` — RLS policy refactor; needs review against
  current prod policy set
- `0191_brin_indexes_timeseries` — non-concurrent BRIN on `anchors` (2.8M
  rows); locks the table during build; apply in maintenance window

**Adding to the exempt list requires:**

1. Code comment in `.github/workflows/migration-drift.yml` with the reason
2. A corresponding Jira ticket to get it out of the exempt state
3. Entry in this runbook under a dated "Exempt migrations" subsection

Exempt ≠ abandoned. Each entry must have a plan to land it.

## Emergency bypass

If the check is blocking an unrelated hotfix AND the hotfix genuinely
does NOT depend on any missing migration, you can:

1. Push the hotfix on a branch that excludes `supabase/migrations/**` from
   the paths filter (the check won't run on PR, but WILL run on push to
   `main` post-merge). This is a narrow bypass, not a workaround.
2. Apply the missing migrations in a dedicated PR BEFORE the hotfix
   merge to `main`.

Never disable the check workflow file. If you're tempted to, the right
move is to apply the missing migrations instead.

## Related

- `.github/workflows/migration-drift.yml` — the check itself
- `docs/confluence/16_migration_drift_prevention.md` — ADR for why
  Option A (read-only diff) was chosen over Option B (auto-apply) or
  Option C (deploy gate)
- `docs/bugs/bug_log.md` — BUG-2026-04-18-004, BUG-2026-04-18-005,
  BUG-2026-04-19-001
- `CLAUDE.md` § 0 MANDATES — migration discipline rules
