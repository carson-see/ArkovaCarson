# agents.md — services/edge
_Last updated: 2026-03-20_

## What This Folder Contains

Cloudflare Worker scripts for peripheral edge tasks. These are **separate from** the Express worker in `services/worker/` and handle only:

- **Report generation** (`src/report-generator.ts`) — PDF reports stored in R2 (INFRA-03)
- **Batch queue consumer** (`src/batch-queue.ts`) — Dequeues batch anchor jobs (INFRA-04)
- **AI fallback** (`src/ai-fallback.ts`) — Workers AI fallback when Gemini is unavailable (INFRA-05)
- **Cloudflare Crawler** (`src/cloudflare-crawler.ts`) — University directory ingestion (P8-S7)
- **MCP Server** (`src/mcp-server.ts`) — Remote MCP server for agentic verification (P8-S19)
- **MCP Tools** (`src/mcp-tools.ts`) — Tool definitions for verify + search

## Current State

**All INFRA stories COMPLETE.** Edge workers have real application logic (batch queue, R2 storage, AI fallback, MCP server, crawler). ADR-002 approved.

## Do / Don't Rules

- **DO** keep edge workers lightweight — peripheral tasks only
- **DO** use Supabase service role key (from Cloudflare Secrets) for data access
- **DON'T** move core anchor processing, Stripe webhooks, or cron jobs here
- **DON'T** import or reference `services/worker/` code — these are independent
- **DON'T** store document bytes or raw OCR text (Constitution 1.6)
- **DON'T** call `@cloudflare/ai` as primary provider — fallback only (Constitution 1.1)

## Dependencies

- `wrangler` (dev dep, root package.json)
- `@cloudflare/ai` (dev dep — deprecated, will use native bindings)
- ADR-002: `docs/confluence/15_zero_trust_edge_architecture.md`
- INFRA-02 through INFRA-05 story cards: `docs/stories/13_infrastructure_edge.md`
