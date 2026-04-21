/**
 * MCP Per-API-Key Rate Limiting (SCRUM-919 MCP-SEC-01)
 *
 * Caps blast radius from a compromised API key. Buckets per
 * (api_key_id, tool_name) in one-minute windows using Cloudflare KV.
 *
 * The KV binding (`env.MCP_RATE_LIMIT_KV`) is OPTIONAL — when unset the
 * limiter logs one warning at module load and passes every request
 * through. That way preview / local / fork deploys don't break.
 *
 * Buckets:
 *   default               — 1000 req/min per API key
 *   nessie_query          —  100 req/min (Gemini budget protection)
 *   oracle_batch_verify   —   10 req/min (can multiply to 250 verifies)
 *   anchor_document       —   60 req/min (write path + future HMAC signing)
 *
 * Strategy: fixed-window counter stored as a KV JSON blob with TTL = 120s.
 * Fixed window has known burst behaviour at boundaries but is by far the
 * cheapest implementation on CF KV. Swap to sliding window if abuse patterns
 * demand it (tracked as a follow-up in the story).
 */

import type { Env } from './env';

/** Per-tool request-per-minute budget. Tools missing from this map use `default`. */
const TOOL_LIMITS_RPM: Record<string, number> = {
  default: 1000,
  nessie_query: 100,
  oracle_batch_verify: 10,
  anchor_document: 60,
};

export type RateLimitDecision =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number; limit: number; toolName: string };

let kvWarningLogged = false;
function warnKvMissingOnce(): void {
  if (kvWarningLogged) return;
  kvWarningLogged = true;
  console.warn('[mcp-rate-limit] MCP_RATE_LIMIT_KV binding missing — rate limiting DISABLED. Provision via `wrangler kv:namespace create MCP_RATE_LIMIT_KV` + update wrangler.toml.');
}

function currentWindowStart(now: number = Date.now()): number {
  // One-minute windows aligned to wall-clock minutes.
  return Math.floor(now / 60_000) * 60_000;
}

/**
 * Check + increment the rate-limit counter for (apiKeyId, toolName). Returns
 * a decision. Safe to call when `env.MCP_RATE_LIMIT_KV` is undefined — that
 * case is a pass-through with a one-time console warning.
 */
export async function enforceRateLimit(
  env: Env,
  apiKeyId: string | null,
  toolName: string,
): Promise<RateLimitDecision> {
  const kv = env.MCP_RATE_LIMIT_KV;
  if (!kv) {
    warnKvMissingOnce();
    return { ok: true };
  }

  // OAuth-bearer callers (no API key) don't have a stable per-agent bucket
  // today — rate-limit them by user id on the auth layer. For now we skip
  // the counter to avoid one bucket per OAuth user; tightening this is an
  // MCP-SEC-01 follow-up.
  if (!apiKeyId) {
    return { ok: true };
  }

  const limit = TOOL_LIMITS_RPM[toolName] ?? TOOL_LIMITS_RPM.default;
  const windowStart = currentWindowStart();
  const key = `rl:${apiKeyId}:${toolName}:${windowStart}`;

  // Read-increment-write. CF KV isn't strongly consistent across regions, so
  // distributed bursts can exceed the limit by a small margin. Acceptable for
  // v1 — the goal is order-of-magnitude protection against a stolen key,
  // not hard accuracy.
  let count = 0;
  try {
    const raw = await kv.get(key);
    count = raw ? Number(raw) : 0;
  } catch (err) {
    console.error('[mcp-rate-limit] KV read failed; fail-open:', err);
    return { ok: true };
  }

  if (count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + 60_000 - Date.now()) / 1000));
    return { ok: false, retryAfterSeconds, limit, toolName };
  }

  try {
    // TTL 120s gives one extra minute of slack so a just-opened bucket
    // can't disappear mid-window. Fire-and-forget-ish — we await but a
    // failure degrades to fail-open rather than blocking the caller.
    await kv.put(key, String(count + 1), { expirationTtl: 120 });
  } catch (err) {
    console.error('[mcp-rate-limit] KV write failed; fail-open:', err);
    return { ok: true };
  }

  return { ok: true };
}

/** Test-only: reset the "warning logged once" flag so tests can re-exercise it. */
export function __resetKvWarningForTests(): void {
  kvWarningLogged = false;
}
