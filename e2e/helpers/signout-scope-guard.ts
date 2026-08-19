/**
 * Unscoped-signOut detector (2026-08-15 session-revocation cascade).
 *
 * supabase-js `auth.signOut()` defaults to `scope: 'global'`: it revokes every
 * session for the user, not just the calling client's. In e2e code the users
 * are SHARED seed users whose `.auth/*.json` storageState sessions
 * (`auth.setup.ts`) are reused by every spec in a single-invocation run, so a
 * bare `signOut()` in one spec's teardown kills authentication for every
 * later spec — observed 2026-08-15 on the fullsoak side-rig, where
 * `cross-tenant.spec.ts`'s PostgREST-leg `afterAll` (PR #2213) bounced every
 * subsequent orgAdminPage spec to /login while GoTrue answered 403
 * `session_not_found` for the still-unexpired storageState JWT.
 *
 * `findUnscopedSignOutCalls` is the pure core; `tests/infra/`
 * `signout-scope-guard.test.ts` unit-tests it and runs it over every file in
 * `e2e/` as a ratchet. E2e code must pass an explicit scope — normally
 * `{ scope: 'local' }`, matching `src/hooks/useAuth.ts`.
 */

export interface UnscopedSignOutHit {
  /** 1-based line number of the offending call. */
  line: number;
  /** The trimmed source line, for the failure message. */
  snippet: string;
}

/**
 * Matches `.auth.signOut()` / `.auth.signOut(  )` — an argument-less call on
 * an `auth` member, which inherits supabase-js's `scope: 'global'` default.
 * Calls passing any argument (an explicit scope object) do not match, and
 * neither do unrelated bare `signOut()` identifiers (e.g. the useAuth wrapper).
 */
const UNSCOPED_SIGNOUT_RE = /\.auth\.signOut\(\s*\)/;

export function findUnscopedSignOutCalls(source: string): UnscopedSignOutHit[] {
  const hits: UnscopedSignOutHit[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (UNSCOPED_SIGNOUT_RE.test(lines[i])) {
      hits.push({ line: i + 1, snippet: lines[i].trim() });
    }
  }
  return hits;
}
