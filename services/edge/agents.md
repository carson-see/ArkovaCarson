# agents.md — services/edge
_Last updated: 2026-04-21_

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
- MCP server: API key (`X-API-Key`) OR Supabase JWT (`Authorization: Bearer`). `validateApiKey` + `validateBearer` race in parallel; first success wins. User-id is threaded into a `ScopedConfig` object and passed to every tool handler so tools can org-scope (see `get_agents_for_user` pattern below).
- MCP tool errors: pass through `safeErrorText(err, context)` — never return `String(err)` directly (stack traces + URLs leak). Detail goes to `console.error`; clients get `{error, code: 'TOOL_ERROR'}`.

## MCP — rogue-agent posture (2026-04-20 audit)

PR #455 closed the critical findings:
- `list_agents` previously used service-role + no org filter → cross-org leak. Now calls `get_agents_for_user(p_user_id)` SECURITY DEFINER RPC (migration 0221) joining through `org_members`.
- Zod input validators tightened: `public_id` → `/^ARK-[A-Z0-9-]{3,60}$/` + max 64; `content_hash` → 64 hex (reuses exported `SHA256_HEX_RE` from `mcp-tools.ts`); `max_results`/`limit` → int 1–50; `source_url` → URL + ≤2048.
- `oracle_batch_verify` description no longer claims HMAC-signed results. Real signing tracked as MCP-SEC-02.

Open (epic [SCRUM-918](https://arkova.atlassian.net/browse/SCRUM-918)):
- MCP-SEC-01 per-API-key rate limiting via CF KV
- MCP-SEC-02 real HMAC signing on `oracle_batch_verify`
- MCP-SEC-03 replace service-role with scoped role / JWT forwarding across ALL tools (not just `list_agents`)
- MCP-SEC-04 idempotency keys on `anchor_document`
- MCP-SEC-05 prompt-injection defensive framing in prompt templates
- MCP-SEC-06 audit logging on every MCP tool invocation

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
