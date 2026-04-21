/**
 * MCP IP / origin allowlist + Cloudflare bot-management gate.
 *
 * Reads per-API-key allowlist entries from `MCP_ORIGIN_ALLOWLIST_KV`
 * (keyed `allow:<api_key_id>`) and decides allow / challenge / reject.
 * Sits between auth and tool dispatch so untrusted origins never reach
 * the auth layer.
 *
 * When no KV binding or no entry exists for the key, we default to
 * `challenge` — admins can opt a key out by writing a wildcard-CIDR
 * entry. The module is pure; `computeAllowlistDecision()` is tested
 * without the Workers runtime.
 */

import type { Env } from './env';

/** Decision returned by the gate. */
export type AllowlistDecision =
  | { ok: true; reason: 'allowlisted' | 'no_kv_binding' | 'explicit_wildcard' }
  | { ok: false; reason: 'challenge'; retryable: true }
  | { ok: false; reason: 'rejected'; retryable: false };

/** Per-API-key KV record shape. */
export interface AllowlistEntry {
  /**
   * `allowlist` → only requests matching `cidrs` / `origins` succeed.
   * `challenge` → unmatched requests get a bot-management challenge.
   * `deny`      → rejected outright (used for revoked keys).
   */
  mode: 'allowlist' | 'challenge' | 'deny';
  /** IPv4 or IPv6 CIDRs. `0.0.0.0/0` and `::/0` are wildcards. */
  cidrs?: string[];
  /** Exact `Origin` header matches. Empty → not checked. */
  origins?: string[];
  /**
   * When `true`, the Cloudflare bot-management verdict on the request
   * must be in `acceptableVerdicts` before the request is allowed.
   */
  requireBotVerdict?: boolean;
  /** Accepted CF bot-management verdict labels. */
  acceptableVerdicts?: Array<'LIKELY_HUMAN' | 'LIKELY_AUTOMATED' | 'VERIFIED_BOT'>;
}

/** Narrow request fields the pure gate needs. */
export interface AllowlistRequest {
  clientIp: string | null;
  origin: string | null;
  /** Cloudflare bot-management verdict when the platform rule fires. */
  cfBotVerdict?: string | null;
}

/**
 * IPv4 CIDR match. IPv6 is left to the Cloudflare WAF — CIDRs here are
 * expected to be IPv4 + the `::/0` wildcard for "any IPv6".
 */
export function ipInCidr(ip: string, cidr: string): boolean {
  if (cidr === '0.0.0.0/0') return ip.includes('.');
  if (cidr === '::/0') return ip.includes(':');

  const [base, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  if (!base || Number.isNaN(bits)) return false;

  const baseParts = base.split('.').map(Number);
  const ipParts = ip.split('.').map(Number);
  if (baseParts.length !== 4 || ipParts.length !== 4) return false;
  if (baseParts.some((n) => Number.isNaN(n)) || ipParts.some((n) => Number.isNaN(n))) return false;

  const toInt = (parts: number[]): number => parts.reduce((acc, p) => ((acc << 8) | p) >>> 0, 0);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(baseParts) & mask) === (toInt(ipParts) & mask);
}

/**
 * Pure allowlist decision given a loaded KV entry (or `null` for "no
 * entry found"). Tests exercise every branch from here.
 */
export function computeAllowlistDecision(
  entry: AllowlistEntry | null,
  req: AllowlistRequest,
): AllowlistDecision {
  if (!entry) return { ok: false, reason: 'challenge', retryable: true };
  if (entry.mode === 'deny') return { ok: false, reason: 'rejected', retryable: false };

  const cidrs = entry.cidrs ?? [];
  const origins = entry.origins ?? [];

  const wildcardCidr = cidrs.includes('0.0.0.0/0') || cidrs.includes('::/0');
  const ipMatched = req.clientIp ? cidrs.some((c) => ipInCidr(req.clientIp as string, c)) : false;
  const originMatched = req.origin ? origins.includes(req.origin) : false;

  if (entry.mode === 'allowlist') {
    // Allowlist mode requires an affirmative match unless wildcarded.
    if (wildcardCidr) return { ok: true, reason: 'explicit_wildcard' };
    if (cidrs.length === 0 && origins.length === 0) {
      return { ok: false, reason: 'challenge', retryable: true };
    }
    if (ipMatched || originMatched) {
      if (entry.requireBotVerdict) {
        const verdicts = entry.acceptableVerdicts ?? ['LIKELY_HUMAN', 'VERIFIED_BOT'];
        const verdict = req.cfBotVerdict ?? '';
        if (!verdicts.includes(verdict as typeof verdicts[number])) {
          return { ok: false, reason: 'challenge', retryable: true };
        }
      }
      return { ok: true, reason: 'allowlisted' };
    }
    return { ok: false, reason: 'rejected', retryable: false };
  }

  // `challenge` mode — match = pass, else bot-management gate.
  if (ipMatched || originMatched) return { ok: true, reason: 'allowlisted' };
  return { ok: false, reason: 'challenge', retryable: true };
}

/**
 * Load the per-API-key entry from KV + compute a decision. Returns a
 * pass-through decision when the KV binding is missing (dev / preview).
 */
export async function enforceOriginAllowlist(
  env: Env,
  apiKeyId: string | null,
  req: AllowlistRequest,
): Promise<AllowlistDecision> {
  const kv = env.MCP_ORIGIN_ALLOWLIST_KV;
  if (!kv) return { ok: true, reason: 'no_kv_binding' };
  // OAuth-bearer callers have no apiKeyId → no per-key KV entry to look
  // up. Fall through to the "no entry" branch so the gate still
  // challenges them instead of silently allowing. Tests lock this in.
  if (!apiKeyId) return computeAllowlistDecision(null, req);

  let entry: AllowlistEntry | null = null;
  try {
    const raw = await kv.get(`allow:${apiKeyId}`);
    entry = raw ? (JSON.parse(raw) as AllowlistEntry) : null;
  } catch (err) {
    console.error('[mcp-origin-allowlist] KV read failed; fail-safe to challenge:', err);
    return { ok: false, reason: 'challenge', retryable: true };
  }

  return computeAllowlistDecision(entry, req);
}

/** Render a `challenge` or `rejected` decision to an HTTP response. */
export function allowlistDecisionToResponse(
  decision: Exclude<AllowlistDecision, { ok: true }>,
  corsOrigin: string,
): Response {
  if (decision.reason === 'challenge') {
    return new Response(
      JSON.stringify({
        error: 'origin_challenge_required',
        message: 'Request origin must pass Cloudflare bot-management before MCP access is granted.',
        docs: 'https://app.arkova.ai/docs/mcp/bot-management',
      }),
      {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': corsOrigin,
          // Turnstile widget key is surfaced via headers so downstream
          // agents can render a challenge without hardcoding site keys.
          'CF-MCP-Challenge': 'turnstile',
        },
      },
    );
  }

  return new Response(
    JSON.stringify({
      error: 'origin_rejected',
      message: 'Request origin is not permitted to reach the MCP endpoint.',
    }),
    {
      status: 403,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': corsOrigin,
      },
    },
  );
}
