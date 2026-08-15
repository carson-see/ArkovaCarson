/**
 * MCP kill-switch gate.
 *
 * Checks the `ENABLE_MCP_SERVER` switchboard flag and short-circuits
 * the MCP endpoint when it is false. Designed so an incident responder
 * can disable the MCP surface in under 60 seconds by flipping a row in
 * `switchboard_flags` — no redeploy required.
 *
 * Fail direction: **OPEN**. An unconfigured environment, an unreadable
 * switchboard, or a malformed answer all serve traffic; only an explicit
 * `enabled = false` row trips the switch. This is deliberate — the kill switch
 * exists to let a human stop the surface, not to make a missing row an outage.
 * See the BUG-021 note at `defaultFetchFlag` for how that guarantee is
 * actually obtained (it was documented but not implemented until 2026-08).
 *
 * Cache: the flag value is cached in a module-scope variable for 30s
 * per CF isolate. Unknown / failed reads are NOT cached so a Supabase
 * outage does not extend the fail-open window past the next request.
 */

/** Cache TTL — hit the flag table at most once per this window. */
const FLAG_CACHE_MS = 30_000;

/** Supabase RPC timeout — shorter than the audit-log 10s because
 *  every MCP request gates on this on cold cache. */
const FLAG_FETCH_TIMEOUT_MS = 2_500;

/** Default response values — see `docs/runbooks/mcp-kill-switch.md`. */
const RETRY_AFTER_SECONDS = 60;
const DISABLED_ERROR_CODE = 'mcp_disabled';

export interface KillSwitchEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

/** `null` signals "flag read failed — do not cache the fail-open
 *  result, retry on the next request". `true`/`false` are cached. */
export type FlagFetchResult = boolean | null;

export interface KillSwitchDeps {
  env: KillSwitchEnv;
  now?: () => number;
  fetchFlag?: (env: KillSwitchEnv) => Promise<FlagFetchResult>;
}

interface CacheEntry {
  enabled: boolean;
  expiresAt: number;
}

let cache: CacheEntry | null = null;

/** Reset the cache — tests only. */
export function __resetKillSwitchCache(): void {
  cache = null;
}

async function defaultFetchFlag(env: KillSwitchEnv): Promise<FlagFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FLAG_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/get_flag`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      // BUG-021: `p_default` is REQUIRED here, and must be `true`.
      //
      // `get_flag(p_flag_key text, p_default boolean DEFAULT false)` folds
      // "row absent" into `p_default` — it does NOT return NULL for a missing
      // row. Omitting the argument therefore resolved a fresh, never-seeded
      // `switchboard_flags` to FALSE, and this gate served `mcp_disabled` to
      // every caller: the fail-open documented in this file's header was
      // unreachable from a real database, and the `data === null` branch below
      // could only ever fire on a malformed response.
      //
      // Passing `true` moves the fail direction into the call, where it
      // belongs. The fail-CLOSED gates (`middleware/featureGate.ts`,
      // `middleware/partnerProvisioningGate.ts`) keep the default `false` for
      // exactly the same reason — each caller declares what "unconfigured"
      // means for its own surface. A caller that must tell "absent" from
      // "explicitly false" cannot use this RPC at all; see
      // `services/worker/src/routes/ingestionResponse.ts`.
      body: JSON.stringify({ p_flag_key: 'ENABLE_MCP_SERVER', p_default: true }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as boolean | null;
    // Defensive only: with p_default: true a healthy DB cannot answer null.
    if (data === null || data === undefined) return true;
    return Boolean(data);
  } catch (err) {
    console.error('[mcp-kill-switch] flag read failed; fail-open uncached:', err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns true iff the MCP server should serve requests. Caches only
 * definite (true/false) answers for `FLAG_CACHE_MS`; `null` (failure)
 * still fail-opens but the next request retries.
 */
export async function isMcpEnabled(deps: KillSwitchDeps): Promise<boolean> {
  const now = deps.now ?? (() => Date.now());
  const t = now();
  if (cache && cache.expiresAt > t) return cache.enabled;

  const fetcher = deps.fetchFlag ?? defaultFetchFlag;
  const result = await fetcher(deps.env);
  if (result === null) return true;
  cache = { enabled: result, expiresAt: t + FLAG_CACHE_MS };
  return result;
}

/** Standard 503 response body for a tripped kill-switch. Retry-After
 *  is a hint — the incident responder ultimately decides when to flip
 *  the flag back. */
export function mcpDisabledResponse(corsOrigin: string): Response {
  return new Response(
    JSON.stringify({
      error: DISABLED_ERROR_CODE,
      message: 'MCP server is temporarily disabled by an operator.',
      retry_after_seconds: RETRY_AFTER_SECONDS,
    }),
    {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(RETRY_AFTER_SECONDS),
        'Access-Control-Allow-Origin': corsOrigin,
        Vary: 'Origin',
      },
    },
  );
}
