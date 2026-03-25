# agents.md — services/edge
_Last updated: 2026-03-24_

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
