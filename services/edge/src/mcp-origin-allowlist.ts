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
 *
 * SCRUM-1283 (R3-10) sub-issue A — KV write contract:
 *   When `MCP_ALLOWLIST_HMAC_SECRET` is set (production), each KV value
 *   under `allow:<api_key_id>` MUST be the JSON shape:
 *     { "value": <inner-entry-json-string>, "signature": "<hex-hmac>" }
 *   where signature = HMAC-SHA256(value, secret) hex-encoded. Verify
 *   uses `crypto.subtle` with constant-time compare. Mismatch ⇒
 *   challenge (fail-closed). When the secret is unset (dev/preview),
 *   the legacy raw-JSON entry shape is still accepted for back-compat.
 *   Operators wrap entries via the `tools/edge/sign-allowlist-entry.ts`
 *   helper before `wrangler kv put`.
 */

import { z } from 'zod';
import type { Env } from './env';

/** Decision returned by the gate. */
export type AllowlistDecision =
  | { ok: true; reason: 'allowlisted' | 'no_kv_binding' | 'explicit_wildcard' }
  | { ok: false; reason: 'challenge'; retryable: true }
  | { ok: false; reason: 'rejected'; retryable: false };

/** Zod schema for the per-API-key KV record. CLAUDE.md §1.2 requires Zod
 *  on every write path — KV entries enter the edge via a write path the
 *  edge does not control (Cloudflare dashboard), so a malformed or
 *  tampered entry must fail closed rather than silently grant access. */
const ALLOWLIST_ENTRY_SCHEMA = z
  .object({
    mode: z.enum(['allowlist', 'challenge', 'deny']),
    cidrs: z.array(z.string()).optional(),
    origins: z.array(z.string()).optional(),
    requireBotVerdict: z.boolean().optional(),
    acceptableVerdicts: z
      .array(z.enum(['LIKELY_HUMAN', 'LIKELY_AUTOMATED', 'VERIFIED_BOT']))
      .optional(),
  })
  .strict();

export type AllowlistEntry = z.infer<typeof ALLOWLIST_ENTRY_SCHEMA>;

/** Narrow request fields the pure gate needs. */
export interface AllowlistRequest {
  clientIp: string | null;
  origin: string | null;
  /** Cloudflare bot-management verdict when the platform rule fires. */
  cfBotVerdict?: string | null;
}

/**
 * IPv4 CIDR match. IPv6 is left to the Cloudflare WAF — CIDRs here are
 * expected to be IPv4 + the `::/0` wildcard for "any IPv6". Out-of-range
 * prefix lengths (e.g. `/33`, `/-1`) return false rather than producing a
 * garbage mask from JS's 32-bit shift semantics.
 */
export function ipInCidr(ip: string, cidr: string): boolean {
  if (cidr === '0.0.0.0/0') return ip.includes('.');
  if (cidr === '::/0') return ip.includes(':');

  const [base, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  if (!base || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const baseParts = base.split('.').map(Number);
  const ipParts = ip.split('.').map(Number);
  if (baseParts.length !== 4 || ipParts.length !== 4) return false;
  if (baseParts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  if (ipParts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;

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
    if (raw) {
      // SCRUM-1283 (R3-10) sub-issue A: when an HMAC secret is configured,
      // require the `{value, signature}` envelope shape and verify the
      // signature before parsing the inner entry. Without the secret
      // (dev/preview), accept the legacy raw entry JSON for back-compat.
      const innerJson = await unwrapSignedEntry(raw, env.MCP_ALLOWLIST_HMAC_SECRET);
      if (innerJson === null) {
        console.error(
          '[mcp-origin-allowlist] KV entry failed HMAC verification or envelope shape; fail-safe to challenge',
        );
        return { ok: false, reason: 'challenge', retryable: true };
      }
      const parsed = ALLOWLIST_ENTRY_SCHEMA.safeParse(JSON.parse(innerJson));
      if (!parsed.success) {
        // Malformed / tampered / schema-incompatible entry → fail closed.
        console.error(
          '[mcp-origin-allowlist] KV entry failed schema validation; fail-safe to challenge',
        );
        return { ok: false, reason: 'challenge', retryable: true };
      }
      entry = parsed.data;
    }
  } catch (err) {
    console.error('[mcp-origin-allowlist] KV read failed; fail-safe to challenge:', err);
    return { ok: false, reason: 'challenge', retryable: true };
  }

  return computeAllowlistDecision(entry, req);
}

/** SCRUM-1283 (R3-10) sub-issue A: unwrap and verify a signed allowlist
 *  KV value. Returns the inner-entry JSON string when the envelope is
 *  valid OR when no secret is configured (legacy back-compat). Returns
 *  `null` when an envelope is required but missing/forged. */
export async function unwrapSignedEntry(
  raw: string,
  secret: string | undefined,
): Promise<string | null> {
  if (!secret) {
    // Legacy mode: accept the raw entry JSON as-is.
    return raw;
  }
  let envelope: { value?: unknown; signature?: unknown };
  try {
    envelope = JSON.parse(raw) as { value?: unknown; signature?: unknown };
  } catch {
    return null;
  }
  if (typeof envelope.value !== 'string' || typeof envelope.signature !== 'string') {
    return null;
  }
  const expected = await hmacSha256Hex(secret, envelope.value);
  if (!constantTimeEqualHex(expected, envelope.signature)) {
    return null;
  }
  return envelope.value;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Hex strings only; equal length required. Constant-time over the bytes. */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
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
          Vary: 'Origin',
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
        Vary: 'Origin',
      },
    },
  );
}
