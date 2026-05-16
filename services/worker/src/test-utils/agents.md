# services/worker/src/test-utils/

Shared test utility helpers used across worker test suites.

## Files

- **migrations.ts** — Helpers for reading migration files in tests. `migrationPath(name)` resolves a migration filename to its path (checks `supabase/migrations/` first, falls back to `docs/migrations-archive/`). `readMigration(name)` returns the SQL content.

## Rules

- Test utilities must not make real API calls or modify DB state.
- Migration path resolution supports both live and archived migrations.
