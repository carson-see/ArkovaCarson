# ADR-002: Zero Trust Ingress + Edge Architecture
_Last updated: 2026-03-12 ~2:00 PM EST | Story: INFRA-01 through INFRA-08_

## Status

**PROPOSED** — Awaiting review before implementation.

## Context

The Arkova worker (`services/worker/`) is a Node.js + Express application deployed to a Docker container (target: GCP Cloud Run per MVP-01/MVP-26). The current architecture exposes public ingress ports on the container host for Stripe webhooks, anchor processing, and billing portal endpoints.

This creates three problems:
1. **Attack surface**: Public ports are discoverable and targetable (DDoS, credential stuffing, webhook forgery).
2. **Edge compute gap**: PDF report generation and batch queue processing run inside the main container, consuming resources meant for anchor processing.
3. **AI fallback**: P8 AI Intelligence relies solely on Vertex AI (Gemini). A single-provider dependency creates availability risk.

## Decision

### 1. Cloudflare Tunnel for Zero Trust Ingress

Replace public GCP ingress with a Cloudflare Tunnel (`cloudflared`) sidecar. The Express worker container is **not** ported to Cloudflare Workers — it remains a standard Node.js Docker container.

```
                          ┌─────────────────────────┐
   Internet               │   Cloudflare Edge       │
   (Stripe, browsers)     │   ┌─────────────────┐   │
   ────────────────────▶   │   │ Tunnel Ingress  │   │
                          │   │ (cloudflared)    │   │
                          │   └────────┬────────┘   │
                          │            │             │
                          │   ┌────────▼────────┐   │
                          │   │ WAF + Rate Limit │   │
                          │   │ + Bot Management │   │
                          │   └────────┬────────┘   │
                          └────────────┼─────────────┘
                                       │ encrypted tunnel
                          ┌────────────▼─────────────┐
                          │   GCP Cloud Run          │
                          │   ┌─────────────────┐    │
                          │   │ Express Worker   │    │
                          │   │ (no public port) │    │
                          │   └─────────────────┘    │
                          └──────────────────────────┘
```

**Key principle**: No public ingress ports on the container host. All traffic enters through Cloudflare's edge, which provides WAF, DDoS protection, rate limiting, and bot management before reaching the worker.

### 2. Cloudflare Workers for Peripheral Edge Tasks

New, lightweight edge tasks run on Cloudflare Workers (not inside the Express container):

| Edge Task | Cloudflare Product | Why Edge |
|-----------|-------------------|----------|
| Batch anchor queue | Queues | Decouple batch submissions from processing; dead-letter support |
| PDF report generation | Workers (with R2) | CPU-intensive; isolate from anchor processing |
| AI fallback inference | Workers AI | Edge-local inference; no round-trip to Vertex |

These are **new codepaths** — the existing Express worker is not modified. The Workers call back to Supabase (via service role) for data access.

### 3. AI Provider Abstraction Layer (extends P8 IAIProvider)

```
IAIProvider (interface)
├── GeminiADKProvider        — PRIMARY (Vertex AI ADK, P8-S4)
├── CloudflareAIProvider     — FALLBACK (Workers AI / Nemotron, edge-local)
└── ReplicateProvider        — QA/SYNTHETIC ONLY (offline data generation)
```

- `GeminiADKProvider` remains primary for all production extraction (P8-S4/S5).
- `CloudflareAIProvider` activates only when Gemini is unavailable (circuit breaker pattern).
- `ReplicateProvider` is **never** called in production request paths. Used exclusively for generating synthetic test data for QA pipelines.

### 4. Sentry Observability

Add `@sentry/node` (worker) and `@sentry/react` (frontend) for error tracking and performance monitoring. This fills the observability gap — currently the project has structured logging but no centralized error aggregation.

### 5. MCP Server (Future)

`@modelcontextprotocol/sdk` scaffolds an MCP server for exposing Arkova's verification API to AI agents. This is a future capability (post-P4.5) and the SDK is installed now only to reserve the dependency slot. No MCP code is written in Phase 0.

## Consequences

### What changes
- `cloudflared` sidecar added to Docker Compose and GCP Cloud Run task definition
- New `services/edge/` directory for Cloudflare Worker scripts (separate from `services/worker/`)
- `wrangler.toml` in project root for edge worker configuration
- New dependencies added to locked tech stack (Section 1.1 amendment)
- Migration 0051 enables `pgvector` for future institution embeddings

### What does NOT change
- `services/worker/` remains Node.js + Express on Docker/Cloud Run
- Supabase remains the primary database (no data moves to Cloudflare)
- Frontend remains React on Vercel
- P8 primary AI path remains Vertex AI ADK with Gemini Flash
- Constitution 1.6 (documents never leave device) is unaffected
- Constitution 4A (PII-stripped metadata exception) is unaffected

## File Placement

```
services/
  worker/                    ← UNCHANGED — Express container
  edge/                      ← NEW — Cloudflare Worker scripts
    wrangler.toml            ← Edge worker config (bindings, routes)
    src/
      report-generator.ts   ← PDF report generation worker
      batch-queue.ts         ← Queue consumer for batch anchors
      ai-fallback.ts         ← Cloudflare Workers AI fallback provider
wrangler.toml                ← Root config (R2 bucket, queue bindings)
```

## Security Notes

- `cloudflared` tunnel credentials stored in GCP Secret Manager (MVP-27), never in code
- Cloudflare Workers use service role key (from Cloudflare Secrets) for Supabase access
- R2 bucket (`ARKOVA_REPORTS`) access restricted to Workers with binding — no public access
- Sentry DSN stored as environment variable, not hardcoded
- Replicate API key restricted to QA environment only (`NODE_ENV=test` or `ENABLE_SYNTHETIC_DATA=true`)

## Change Log

| Date | Change |
|------|--------|
| 2026-03-12 | ADR-002 proposed — Zero Trust ingress + edge architecture |
