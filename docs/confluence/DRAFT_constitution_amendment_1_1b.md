# DRAFT — Constitution Amendment 1.1B: Infrastructure & Edge Stack
_Last updated: 2026-03-12 ~2:00 PM EST_
_Status: PROPOSED — requires approval before applying to CLAUDE.md_
_ADR: ADR-002 (docs/confluence/15_zero_trust_edge_architecture.md)_

## What This Amends

CLAUDE.md Section 1.1 "Tech Stack (Locked)" — adds new rows to the tech stack table and a scoping note to the hard constraints.

## Current Section 1.1 Tech Stack Table

```
| Layer | Technology | Notes |
|-------|-----------|-------|
| Frontend | React 18 + TypeScript + Tailwind CSS + shadcn/ui + Lucide React | Vite bundler |
| Database | Supabase (Postgres + Auth) | RLS mandatory on all tables |
| Validation | Zod | All write paths validated before DB call |
| Routing | react-router-dom v6 | Named routes in `src/lib/routes.ts` |
| Worker | Node.js + Express in `services/worker/` | Webhooks, anchoring jobs, cron |
| Payments | Stripe (SDK + webhooks) | Worker-only, never browser |
| Chain | bitcoinjs-lib + AWS KMS (target) | SignetChainClient implemented; MockChainClient for tests. AWS KMS for mainnet TBD. |
| Testing | Vitest + Playwright + RLS test helpers | `npm test`, `npm run test:coverage`, `npm run test:rls`, `npm run test:e2e` |
```

## Proposed Additions (4 new rows)

```
| Layer | Technology | Notes |
|-------|-----------|-------|
| ... (existing rows unchanged) ... |
| Ingress | Cloudflare Tunnel (`cloudflared`) | Zero Trust ingress to worker container. No public ports. |
| Edge Compute | Cloudflare Workers + `wrangler` (dev dep) | Peripheral tasks only (Queues, R2, AI fallback). NOT for core worker logic. |
| Observability | Sentry (`@sentry/react`, `@sentry/node`, `@sentry/profiling-node`) | Error tracking + performance. PII scrubbing mandatory. |
| AI (extended) | `@cloudflare/ai` (fallback), `replicate` (QA only), `@modelcontextprotocol/sdk` (future) | See scoping rules below. Primary AI remains Vertex AI ADK (P8). |
```

## Proposed Hard Constraint Additions

Add after the existing three hard constraints:

```
- Cloudflare Workers handle ONLY peripheral edge tasks (queues, reports, AI fallback). Core anchor processing, Stripe webhooks, and cron jobs stay in `services/worker/` Express container.
- `@cloudflare/ai` is fallback-only — never the primary extraction provider. Gated by `ENABLE_AI_FALLBACK` flag (default: `false`).
- `replicate` is QA/synthetic-data-only — hard-blocked in production (`NODE_ENV=production` + `ENABLE_SYNTHETIC_DATA!=true`).
- `@modelcontextprotocol/sdk` is installed for future use. No MCP server code until P4.5 Verification API is complete.
- Sentry must have PII scrubbing enabled. No user emails, document fingerprints, or API keys in Sentry events (Constitution 1.4 + 1.6).
```

## Proposed File Placement Addition (Section 4)

Add to the file placement map:

```
services/
  worker/                    ← UNCHANGED — Express container (Node.js + Docker)
  edge/                      ← NEW — Cloudflare Worker scripts
    wrangler.toml            ← Edge worker config
    src/
      report-generator.ts   ← PDF report generation (R2 storage)
      batch-queue.ts         ← Queue consumer for batch anchors
      ai-fallback.ts         ← CloudflareAIProvider (Workers AI)
wrangler.toml                ← Root config (R2 bucket, queue, AI bindings)
```

## Proposed Environment Variables Addition (Section 13)

Add to the environment variables block:

```bash
# Cloudflare (edge workers — never in browser)
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=              # wrangler deploy token

# Sentry
VITE_SENTRY_DSN=                   # frontend (browser)
SENTRY_DSN=                        # worker (server)
SENTRY_SAMPLE_RATE=0.1             # performance sampling (default 10%)

# AI Fallback (edge worker only)
ENABLE_AI_FALLBACK=false
CF_AI_MODEL=@cf/nvidia/nemotron    # or equivalent Workers AI model

# Replicate (QA only — hard-blocked in production)
REPLICATE_API_TOKEN=               # only in test/QA environments
ENABLE_SYNTHETIC_DATA=false
```

## Proposed Section 8 Story Status Addition

Add new row to the priority completion table:

```
| INFRA Edge & Ingress | 0/8 | 0 | 8/8 | 0% |
```

Update totals: 124 total stories (was 116).

## What This Does NOT Change

- Constitution 1.2 through 1.10 — unaffected
- Constitution 4A (PII-stripped metadata exception) — unaffected
- `services/worker/` Express architecture — unaffected
- Frontend deployment (Vercel) — unaffected
- Primary AI provider (Vertex AI ADK / Gemini) — unaffected
- Existing story status for P1-P8, MVP, DH — unaffected

## Approval Checklist

- [ ] ADR-002 reviewed and approved
- [ ] INFRA-01 through INFRA-08 story cards reviewed
- [ ] This amendment reviewed
- [ ] All three approved → apply edits to CLAUDE.md, update indexes
