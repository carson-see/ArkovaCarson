/**
 * MCP kill-switch gate.
 *
 * Checks the `ENABLE_MCP_SERVER` switchboard flag and short-circuits
 * the MCP endpoint when it is false. Designed so an incident responder
 * can disable the MCP surface in under 60 seconds by flipping a row in
 * `switchboard_flags` — no redeploy required.
 *
 * Cache: the flag value is cached in a module-scope variable for 30s
 * per CF isolate. That means in the worst case a toggle takes ~30s to
 * propagate to each isolate — still well under the 60s incident SLA.
 *
 * Pure TypeScript — the Supabase fetch is injectable so tests do not
 * need a live DB.
 */

/** Cache TTL — hit the flag table at most once per this window. */
const FLAG_CACHE_MS = 30_000;

export interface KillSwitchEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

export interface KillSwitchDeps {
  env: KillSwitchEnv;
  now?: () => number;
  fetchFlag?: (env: KillSwitchEnv) => Promise<boolean>;
}

interface CacheEntry {
  enabled: boolean;
  expiresAt: number;
}

/** Module-scope cache per isolate. Separate per isolate is fine — the
 *  SLA is 60s, cache is 30s, so new isolates read the flag on first
 *  request and the rest stay within budget. */
let cache: CacheEntry | null = null;

/** Reset the cache — tests only. */
export function __resetKillSwitchCache(): void {
  cache = null;
}

/**
 * Look up `ENABLE_MCP_SERVER`. Uses the public `get_flag` RPC for
 * consistency with every other switchboard caller. Default is `true`
 * so a missing flag (fresh DB) does NOT silently take prod down.
 */
async function defaultFetchFlag(env: KillSwitchEnv): Promise<boolean> {
  try {
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/get_flag`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ p_flag_key: 'ENABLE_MCP_SERVER' }),
    });
    if (!response.ok) return true;
    const data = (await response.json()) as boolean | null;
    if (data === null || data === undefined) return true;
    return Boolean(data);
  } catch (err) {
    console.error('[mcp-kill-switch] flag read failed; fail-open:', err);
    return true;
  }
}

/**
 * Returns true iff the MCP server should serve requests. Caches the
 * result for `FLAG_CACHE_MS`.
 */
export async function isMcpEnabled(deps: KillSwitchDeps): Promise<boolean> {
  const now = deps.now ?? (() => Date.now());
  const t = now();
  if (cache && cache.expiresAt > t) return cache.enabled;

  const fetcher = deps.fetchFlag ?? defaultFetchFlag;
  const enabled = await fetcher(deps.env);
  cache = { enabled, expiresAt: t + FLAG_CACHE_MS };
  return enabled;
}

/** Standard 503 response body for a tripped kill-switch. Retry-After
 *  is a hint — the incident responder ultimately decides when to flip
 *  the flag back. 60s matches the SLA in the parent story. */
export function mcpDisabledResponse(corsOrigin: string): Response {
  return new Response(
    JSON.stringify({
      error: 'mcp_disabled',
      message: 'MCP server is temporarily disabled by an operator.',
      retry_after_seconds: 60,
    }),
    {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '60',
        'Access-Control-Allow-Origin': corsOrigin,
      },
    },
  );
}
