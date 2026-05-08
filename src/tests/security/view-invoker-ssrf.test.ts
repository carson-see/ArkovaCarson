/**
 * SEC-009 / SEC-010 — retired by SCRUM-1668 Path C.
 *
 * Original test asserted that migration 0112 contained specific SQL
 * (REVOKE on http_*, security_invoker=true on views). After Path C
 * collapsed 0000..0289 into the baseline pg_dump, the migration file no
 * longer exists on disk and pg_dump does not preserve negative privilege
 * state (REVOKEs are inferred from absence, not asserted).
 *
 * The two underlying invariants are now enforced elsewhere:
 *   - SEC-009 (view security_invoker): scripts/ci/check-views-security-invoker.ts
 *     runs in the Dependency Scanning CI job and blocks any new view
 *     without `security_invoker = true` (or the
 *     `view-security-definer-intentional` PR label for known exceptions).
 *   - SEC-010 (http extension exposure): the property is "http_*
 *     functions are not granted to anon/authenticated." Any future
 *     migration that re-grants them lands in supabase/migrations/ and
 *     would be caught at review (search for `GRANT EXECUTE ON FUNCTION
 *     http_`). No static SQL test can prove a negative on the pg_dump
 *     baseline; runtime RLS tests (tests/rls/) cover the live state
 *     against staging.
 *
 * Leaving this file intentionally as a no-op test so the path stays
 * grep-discoverable for any future hand-back of the SEC-009/010 IDs.
 */
import { describe, it } from 'vitest';

describe('SEC-009 / SEC-010 — retired (see file header)', () => {
  it.skip('migration-0112 static checks retired — replaced by CI gate + RLS tests', () => {
    // No-op: see file header for the migration trail.
  });
});
