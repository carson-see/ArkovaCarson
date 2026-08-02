# services/worker/src/test-utils/

Shared test utility helpers used across worker test suites.

## Files

- **migrations.ts** — Helpers for reading migration files in tests. `migrationPath(name)` resolves a migration filename to its path (checks `supabase/migrations/` first, falls back to `docs/migrations-archive/`). `readMigration(name)` returns the SQL content.
- **professional-education-migration.test.ts** — Static regression checks for the CPE/CLE foundation migration, including metadata columns, registry RLS posture, and secured-anchor immutability hooks.
- **lazy-supabase-builder.ts** — `createLazyBuilderRecorder()`: records a supabase-js write only when `.then()` is called on the builder, because that is when the real `PostgrestBuilder` issues its HTTP request. Exists so tests can tell "builder constructed" apart from "request issued" — the distinction a `mockReturnThis()` / resolved-Promise mock erases, which let `void db.from('api_keys').update(...)` ship as a silent no-op (PR #1808). Used by `middleware/apiKeyAuth.test.ts` and `api/v2/auth.test.ts`; reach for it whenever asserting a fire-and-forget DB write.
- **hanging-fetch.ts** — `makeHangingFetch()`: a shared `fetch` test double for unbounded-fetch/timeout regression tests. Never resolves on its own but honours `init.signal` (rejects with the signal's abort reason once it fires), so a test can prove a timeout bounds a call without a real network hang. Used by `jobs/courtlistenerFetcher.test.ts` (SCRUM-2975) and `jobs/usptoFetcher.test.ts` — extracted here instead of duplicated per-file when a second consumer needed the identical stub.

## Rules

- Test utilities must not make real API calls or modify DB state.
- Migration path resolution supports both live and archived migrations.
- `makeHangingFetch()` intentionally hangs forever when no `init.signal` is passed — that reproduces the pre-fix bug shape (loud test timeout) rather than silently passing. Don't "fix" it to auto-resolve.
