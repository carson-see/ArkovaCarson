# agents.md — services/edge
_Last updated: 2026-04-27_

## SCRUM-926 — Local JWT verification on `validateBearer` (2026-04-27)

`services/edge/src/mcp-jwt-verify.ts` (new) verifies caller-supplied bearer JWTs locally with HS256 against `SUPABASE_JWT_SECRET` BEFORE the round-trip to `/auth/v1/user`. Defense-in-depth against compromise of the Supabase auth path forging a session for arbitrary user IDs. WebCrypto only — no `jose` dep on the edge bundle (matches `mcp-hmac.ts` convention). Module-scope `cachedKey` memoizes the imported `CryptoKey` so we don't re-derive HMAC bytes per request.

`validateBearer` flow now: (1) fail-closed if `SUPABASE_JWT_SECRET` is unset (one-shot warn); (2) `verifySupabaseJwt` checks `alg`, `exp`, `iat`, `aud`, `iss`, signature, `sub`; (3) belt-and-suspenders round-trip to `/auth/v1/user` (catches server-side revocations the JWT can't reflect); (4) `user.id` cross-check against JWT `sub` — symmetric distrust of both sides. Tests: `src/tests/edge/mcp-jwt-verify.test.ts` covers forged-signature, malformed, expired, iat-future, wrong-aud, wrong-iss, missing-sub all rejected without network call.

Note: the `[MCP-SEC-07]` Jira label is reused by SCRUM-926 (this ticket) — SCRUM-984 below also carries the MCP-SEC-07 tag from the earlier TRUST sprint. Two separate concerns under one tag; both shipped.

## What This Folder Contains

Cloudflare Workers deployment at `edge.arkova.ai`. Handles MCP server, AI fallback, domain crawling, and report generation. Deployed via `wrangler`.

## Endpoints

- **MCP server** — Streamable HTTP transport
- **AI fallback** — Nemotron via Workers AI, gated by `ENABLE_AI_FALLBACK` (default: `false`)
- **Domain crawler** — with SSRF protection (private IP range blocking)
- **Report generation** — on-demand report endpoint

## Auth & Security

- All internal routes require `X-Cron-Secret` header
- Secret comparison uses constant-time algorithm to prevent timing attacks
- No public ports — ingress via Cloudflare only
- MCP server: API key (`X-API-Key`) OR Supabase JWT (`Authorization: Bearer`). `validateApiKey` + `validateBearer` race in parallel; first success wins. `validateBearer` verifies the Supabase JWT locally with `SUPABASE_JWT_SECRET` (`HS256`, `exp`, `iat`, `aud=authenticated`, `iss={SUPABASE_URL}/auth/v1`) before it calls `/auth/v1/user`, then rejects any response whose `user.id` does not match the JWT `sub`. User-id is threaded into a `ScopedConfig` object and passed to every tool handler so tools can org-scope (see `get_agents_for_user` pattern below).
- MCP tool errors: pass through `safeErrorText(err, context)` — never return `String(err)` directly (stack traces + URLs leak). Detail goes to `console.error`; clients get `{error, code: 'TOOL_ERROR'}`.

## MCP — rogue-agent posture (2026-04-20 audit)

PR #455 closed the critical findings:
- `list_agents` previously used service-role + no org filter → cross-org leak. Now calls `get_agents_for_user(p_user_id)` SECURITY DEFINER RPC (migration 0221) joining through `org_members`.
- Zod input validators tightened: `public_id` → `/^ARK-[A-Z0-9-]{3,60}$/` + max 64; `content_hash` → 64 hex (reuses exported `SHA256_HEX_RE` from `mcp-tools.ts`); legacy `max_results`/`limit` → int 1–50, v2 `search.max_results` follows REST v2 `limit` at int 1–100; `source_url` → URL + ≤2048.
- `oracle_batch_verify` description no longer claims HMAC-signed results. Real signing tracked as MCP-SEC-02.

Open (epic [SCRUM-918](https://arkova.atlassian.net/browse/SCRUM-918)):
- MCP-SEC-03 replace service-role with scoped role / JWT forwarding across ALL tools (not just `list_agents`)

### Landed 2026-04-21 (TRUST sprint)

- **MCP-SEC-07** (SCRUM-984) — centralized Zod tool-argument registry at
  `src/mcp-tool-schemas.ts`. `validateToolArgs(name, raw)` returns a
  discriminated union; `withTelemetry` runs it in strict mode before any
  handler fires. Error envelope drops `received` + stack-trace fields.
- **MCP-SEC-08** (SCRUM-985) — origin allowlist gate at
  `src/mcp-origin-allowlist.ts`. Reads `MCP_ORIGIN_ALLOWLIST_KV` entry
  keyed `allow:<api_key_id>`; supports `allowlist|challenge|deny` modes,
  IPv4 CIDRs + origin matches + CF bot-management verdict gate. Pure
  `computeAllowlistDecision` is fully unit-tested.
- **MCP-SEC-09** (SCRUM-987) — rolling-window anomaly detector at
  `src/mcp-anomaly-detection.ts`. Heuristics: rapid tool cycling, auth
  failure burst, cross-tenant enumeration, oversized args, rate-limit
  storm. Dedupe + severity levels + Sentry envelope shipper.

### Landed 2026-04-26 (edge bug-bounty review — SCRUM-1435..1438)

Source-level review + live probes against `edge.arkova.ai`. PR [#582](https://github.com/carson-see/ArkovaCarson/pull/582). Deployed `arkova-edge@16257677-a610-49e2-9ef9-f6b3d5b69d24`.

- **F-1 / MCP-SEC-01 + MCP-SEC-08 plumbing** (BUG-2026-04-26-009 / SCRUM-1435) —
  `MCP_RATE_LIMIT_KV` namespace was never created; `MCP_ORIGIN_ALLOWLIST_KV`
  namespace existed but was never bound. Both gate modules treat missing
  KV as pass-through (dev/preview default), so production was silently
  running with **no per-API-key rate limits and no origin pinning** since
  first deploy. Fix: created the missing namespace, bound both in
  `wrangler.toml`. Both now active in deployed bindings.
- **F-2 / x402 facilitator hardening** (BUG-2026-04-26-010 / SCRUM-1436)
  — `/x402/verify` was unauth + unrate-limited. Added
  `ENABLE_X402_FACILITATOR` kill-switch (default `"false"` → 404),
  strict `0x[0-9a-f]{64}` body regex, and a per-IP 30 req/min KV
  token-bucket rate limit that runs **before** any Base RPC call (caps
  denial-of-wallet on metered RPC quota). Flip the env var when
  `x402PaymentGate` is wired through edge.
- **F-3 / CORS drift** (BUG-2026-04-26-011 / SCRUM-1437) — production
  `Access-Control-Allow-Origin` was reflecting the legacy
  `arkova-carson.vercel.app`. Rotated `ALLOWED_ORIGINS` secret to
  `https://arkova-26.vercel.app,https://app.arkova.ai`; redeployed
  current source. Live ACAO now `arkova-26.vercel.app`. Open follow-up:
  redirect/take down the legacy Vercel project.
- **F-4 / MCP-SEC-02 real signing** (BUG-2026-04-26-012 / SCRUM-1438) —
  `oracle_batch_verify` silently returned bare payload when
  `MCP_SIGNING_KEY` was unset. Generated 48-byte random key + uploaded.
  Code change: missing-key fallback now wraps as
  `{payload, signature:null, alg:null, key_id:null, signed:false}` +
  one-shot `console.warn` so callers fail closed on future rotation
  gaps.

**Operational invariants from this round:**

- Production `wrangler.toml` MUST bind `MCP_RATE_LIMIT_KV` and
  `MCP_ORIGIN_ALLOWLIST_KV`. Both gates fail-OPEN when the KV is
  missing — this is a deliberate dev/preview default but a production
  foot-gun.
- `MCP_SIGNING_KEY` MUST be set as a secret. Verify with
  `npx wrangler@4 versions view <active> --name arkova-edge` and
  confirm the key appears under `Secrets:`.
- `ENABLE_X402_FACILITATOR` stays `"false"` until `x402PaymentGate`
  (in `services/worker/src/middleware/`) is repointed at
  `https://edge.arkova.ai/x402/verify`. The paywall currently defaults
  to `https://x402.org/facilitator`.
- `ALLOWED_ORIGINS` MUST NOT include `arkova-carson.vercel.app`
  (per `feedback_single_source_of_truth.md`). The first comma-separated
  value is what unmatched-origin requests get reflected as the ACAO.

## Do / Don't Rules

- **DO** gate AI fallback behind `ENABLE_AI_FALLBACK` switchboard flag
- **DO** validate and sanitize all crawler target URLs (SSRF protection)
- **DO** use `wrangler` for all deployments
- **DON'T** process documents server-side (Constitution 1.6 — client-side only)
- **DON'T** expose `X-Cron-Secret` in logs or error responses
- **DON'T** use `replicate` in production — QA only
- **DON'T** bypass SSRF protections for internal/private IP ranges
- **DON'T** move core anchor processing, Stripe webhooks, or cron jobs here
- **DON'T** call `@cloudflare/ai` as primary provider — fallback only (Constitution 1.1)
- **DON'T** ship a wrangler.toml without `[[kv_namespaces]]` for `MCP_RATE_LIMIT_KV` and `MCP_ORIGIN_ALLOWLIST_KV` — both gates silently pass-through when the binding is missing (F-1, 2026-04-26)
- **DON'T** flip `ENABLE_X402_FACILITATOR` to `"true"` until the paywall is wired through edge **and** the per-IP rate limit + body regex have been smoke-tested in staging (F-2, 2026-04-26)
- **DON'T** include `arkova-carson.vercel.app` in `ALLOWED_ORIGINS` — the canonical front-end is `arkova-26.vercel.app` only (F-3, 2026-04-26)

## Dependencies

- `@cloudflare/ai` — Workers AI inference (Nemotron fallback)
- `wrangler` — deploy tooling
- Supabase JS client — database reads

## Key Patterns

**Constant-time secret comparison:**
```typescript
const encoder = new TextEncoder();
const a = encoder.encode(provided);
const b = encoder.encode(expected);
if (a.byteLength !== b.byteLength) return false;
return crypto.subtle.timingSafeEqual(a, b);
```

**Org-scoped tool query (list_agents pattern):**
```typescript
// Don't: /rest/v1/<table>?filter with service-role — no user scoping.
// Do: SECURITY DEFINER RPC that takes p_user_id and joins through
// org_members. Migration 0221 is the template.
const resp = await fetch(
  `${config.supabaseUrl}/rest/v1/rpc/get_agents_for_user`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: config.supabaseKey,
      Authorization: `Bearer ${config.supabaseKey}`,
    },
    body: JSON.stringify({ p_user_id: config.userId }),
  },
);
```

**Error redaction (never leak stack traces to MCP clients):**
```typescript
return { content: [{ type: 'text', text: safeErrorText(error, 'tool_name') }] };
```
