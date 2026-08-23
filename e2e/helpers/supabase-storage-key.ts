/**
 * Supabase auth storage-key derivation for E2E session injection (BUG-030 / E-2).
 *
 * When a spec injects a session into `storageState`, it has to write the exact
 * localStorage key the APP will read. supabase-js has no public accessor for
 * that key, but its default is fixed and documented by its own source:
 *
 *     `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`
 *
 * `src/lib/supabase.ts` calls `createClient(VITE_SUPABASE_URL, …)` with no
 * explicit `storageKey`, so that default is what the browser under test uses.
 *
 * The previous code inlined the RESULT of that formula for the local project —
 * `sb-127-auth-token`, where `127` is the first label of `127.0.0.1`. Against
 * any hosted project the browser looks for `sb-<project-ref>-auth-token`,
 * finds nothing, and the injected session is invisible: 15 tests across
 * `onboarding.spec.ts`, `identity.spec.ts` and `route-guards.spec.ts` could
 * only ever pass against a local Supabase.
 *
 * If supabase-js ever changes its default, `tests/infra/supabase-storage-key.test.ts`
 * still pins `sb-127-auth-token` for the local URL, so the mismatch shows up as
 * a unit-test failure rather than as 15 mysterious auth timeouts.
 */

/** Local Supabase API URL — the repo-wide default across the E2E fixtures. */
export const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';

/** Vite dev-server origin — the Playwright `baseURL` default. */
export const DEFAULT_FRONTEND_ORIGIN = 'http://localhost:5173';

type EnvLike = Record<string, string | undefined>;

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/**
 * The localStorage key supabase-js reads a persisted session from, for a given
 * Supabase API URL.
 *
 * Throws rather than returning a plausible-but-wrong key: a wrong key yields an
 * unauthenticated browser and surfaces 30 seconds later as an unrelated
 * "element not found", which is a far more expensive failure to diagnose.
 */
export function supabaseAuthStorageKey(supabaseUrl: string): string {
  let hostname: string;
  try {
    hostname = new URL(supabaseUrl).hostname;
  } catch {
    throw new Error(
      `Cannot derive the Supabase auth storage key: invalid Supabase URL ${JSON.stringify(supabaseUrl)}`,
    );
  }

  const ref = hostname.toLowerCase().split('.')[0];
  if (!ref) {
    throw new Error(
      `Cannot derive the Supabase auth storage key: Supabase URL ${JSON.stringify(supabaseUrl)} has no host label`,
    );
  }

  return `sb-${ref}-auth-token`;
}

/**
 * The Supabase URL the BROWSER under test talks to.
 *
 * `VITE_SUPABASE_URL` wins because that is literally the variable
 * `src/lib/supabase.ts` reads; `E2E_SUPABASE_URL` (which the fixtures use for
 * the service client) is the fallback, and both normally point at the same
 * project. Deriving the storage key from anything else risks writing a key for
 * one project while the app reads another.
 */
export function resolveE2ESupabaseUrl(env: EnvLike = process.env): string {
  return firstNonBlank(env.VITE_SUPABASE_URL, env.E2E_SUPABASE_URL) ?? LOCAL_SUPABASE_URL;
}

/**
 * The frontend origin a `storageState` entry must be filed under.
 *
 * Playwright matches storageState origins by ORIGIN, so a hardcoded
 * `http://localhost:5173` injects the session into an origin a rig browser
 * never visits — the second half of the same portability defect. Defaults to
 * the dev-server origin, so local and CI behaviour is unchanged.
 */
export function resolveE2EFrontendOrigin(env: EnvLike = process.env): string {
  const raw = firstNonBlank(env.E2E_BASE_URL);
  if (!raw) return DEFAULT_FRONTEND_ORIGIN;

  try {
    return new URL(raw).origin;
  } catch {
    throw new Error(`Invalid E2E_BASE_URL ${JSON.stringify(raw)} — expected an absolute URL`);
  }
}
