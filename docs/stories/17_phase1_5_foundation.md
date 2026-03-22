# Phase 1.5: Foundation — Product Requirements

> Source: Arkova-Master-Strategy-Complete, Arkova-Verification-Bootstrap-Deep-Dive, Arkova-Verified-Intelligence-SLM-Analysis
> Created: 2026-03-22 EST | Status: ACTIVE

---

## Overview

Phase 1.5 establishes the technical foundation for Arkova's next stage: a production-ready verification API with x402 micropayments, global data ingestion pipelines, and the first Nessie prototype trained on verified data. This phase runs Months 0-6 with decision gates at Month 3.

**Three workstreams run in parallel:**
1. **Data Pipeline** — EDGAR + USPTO + Federal Register ingestion, Merkle batching, bulk anchoring
2. **Payment Infrastructure** — x402 protocol integration, facilitator setup, per-call billing
3. **Intelligence Foundation** — RAG pipeline, embedding infrastructure, Nessie prototype

---

## WORKSTREAM 1: PUBLIC RECORDS DATA PIPELINE

### PH1-DATA-01: EDGAR Full-Text Fetcher (Enhancement)
**Priority:** P0 | **Effort:** 2 days | **Depends on:** Migration 0077 (PR #126)

The existing `edgarFetcher.ts` (PR #126) fetches search metadata only. This story enhances it to:
- Download full filing text from EDGAR bulk archives (not just search index)
- Parse XBRL/XML/HTML filing formats into plain text
- Store full text in `public_records.metadata.full_text` (or separate column)
- Support resumable bulk download from EDGAR historical archives (back to 1993)
- Filing hours awareness: 6 AM-10 PM ET weekdays for real-time, bulk anytime

**Acceptance Criteria:**
- [ ] Fetcher downloads full 10-K/10-Q/8-K filing text, not just metadata
- [ ] Supports EDGAR bulk download endpoint (no rate limit) for historical backfill
- [ ] Handles XBRL, XML, HTML, and plain text formats
- [ ] Resumable: tracks last-fetched date per source
- [ ] Rate limit: 10 req/sec for search API, unlimited for bulk
- [ ] Unit tests with mocked responses

### PH1-DATA-02: USPTO Patent Fetcher
**Priority:** P0 | **Effort:** 2 days | **Depends on:** Migration 0077

New job: `services/worker/src/jobs/usptoFetcher.ts`
- Fetch patent grants from PatentsView API (data.uspto.gov as of March 2026)
- 45 requests/minute, no API key required
- Bulk CSV downloads for historical backfill (weekly Tuesday updates)
- Store in `public_records` with `source = 'uspto'`, `record_type = 'patent_grant'`
- Fields: patent_number, title, abstract, claims, assignee, filing_date, grant_date

**Acceptance Criteria:**
- [ ] Fetches patent grants via API with proper rate limiting (45 req/min)
- [ ] Bulk CSV download support for historical data
- [ ] Records inserted into public_records with proper metadata
- [ ] Resumable from last fetched patent number
- [ ] Unit tests

### PH1-DATA-03: Federal Register Fetcher
**Priority:** P1 | **Effort:** 1 day | **Depends on:** Migration 0077

New job: `services/worker/src/jobs/federalRegisterFetcher.ts`
- API at federalregister.gov, no auth required, JSON/CSV, daily updates
- Pagination: 2,000 results per query (use date filters for full coverage)
- 50,000+ documents/year: proposed rules, final rules, notices, presidential documents
- Store with `source = 'federal_register'`

**Acceptance Criteria:**
- [ ] Fetches documents with date-range pagination
- [ ] All document types: proposed rules, final rules, notices, presidential docs
- [ ] Resumable from last fetched date
- [ ] Unit tests

### PH1-DATA-04: Merkle Batch Anchoring for Public Records
**Priority:** P0 | **Effort:** 3 days | **Depends on:** PH1-DATA-01

Existing `batch-anchor.ts` handles credential anchors. This story adds a parallel batch anchoring flow specifically for public records:
- New cron job: `processPublicRecordAnchoring()`
- Queries `public_records WHERE anchor_id IS NULL` in batches of 10,000-100,000
- Computes SHA-256 fingerprint of each record's content
- Builds Merkle tree → anchors root to Bitcoin (every 10 minutes)
- Stores Merkle proof in `public_records.metadata.merkle_proof`
- Links `public_records.anchor_id` to the batch anchor record
- Cost: ~$0.002-$0.003 per document at scale ($50-200/mo for 1M docs)

**Acceptance Criteria:**
- [ ] Cron job processes unanchored public records in configurable batch sizes
- [ ] Merkle tree built from SHA-256 fingerprints
- [ ] Single Bitcoin transaction per batch (OP_RETURN with Merkle root)
- [ ] Each record gets individual Merkle proof stored in metadata
- [ ] anchor_id linked after successful anchor
- [ ] Switchboard flag: `ENABLE_PUBLIC_RECORD_ANCHORING`
- [ ] Monitoring: batch size, anchoring cost, records/day metrics logged

### PH1-DATA-05: Pipeline Monitoring Dashboard
**Priority:** P1 | **Effort:** 2 days | **Depends on:** PH1-DATA-01, PH1-DATA-02

Admin-only dashboard page showing:
- Records ingested per source (EDGAR, USPTO, Federal Register) per day/week
- Anchoring status: unanchored, pending, secured counts
- Cost tracking: anchoring costs per batch
- Pipeline health: last successful run, error counts
- Training export status: exported vs. unexported counts

**Acceptance Criteria:**
- [ ] New admin page at `/admin/pipeline`
- [ ] Real-time counts from public_records table
- [ ] Charts: ingestion rate, anchoring rate, cost per day
- [ ] Error log view
- [ ] Platform admin only (carson@arkova.ai)

---

## WORKSTREAM 2: x402 PAYMENT INFRASTRUCTURE

### PH1-PAY-01: x402 Express Middleware Integration
**Priority:** P0 | **Effort:** 3 days | **Depends on:** Migration 0078 (PR #125)

Wire `@x402/express` middleware into the worker's verification API routes:
- Payment gateway: return 402 with payment requirements on protected endpoints
- Self-hosted facilitator configuration (not Coinbase-hosted)
- USDC on Base (network: eip155:84532 for testnet, eip155:8453 for mainnet)
- Record settlements in `x402_payments` table
- Map to existing rate limiting + usage tracking

**Endpoints to gate with x402:**
| Endpoint | Price |
|----------|-------|
| POST /api/v1/verify/:publicId | $0.002 |
| POST /api/v1/verify/batch | $0.002 × count |
| POST /api/v1/ai/search | $0.01 |
| POST /api/v1/nessie/query (future) | $0.01 |

**Acceptance Criteria:**
- [ ] x402 middleware returns 402 Payment Required with correct pricing
- [ ] Facilitator URL configurable via env var
- [ ] Payment verified before request processing
- [ ] Settlement recorded in x402_payments table
- [ ] Existing API key auth still works (x402 is alternative, not replacement)
- [ ] Switchboard flag: `ENABLE_X402_PAYMENTS`
- [ ] Fallback: if x402 disabled, endpoints work with API key auth only
- [ ] Unit tests with mocked facilitator

### PH1-PAY-02: Self-Hosted Facilitator Setup
**Priority:** P0 | **Effort:** 2 days | **Depends on:** PH1-PAY-01

Deploy and configure a self-hosted x402 facilitator:
- Cloudflare Worker or standalone service
- USDC settlement on Base L2
- Fee splitting configuration
- Transaction logging
- Health monitoring

**Acceptance Criteria:**
- [ ] Facilitator deployed and accessible
- [ ] USDC settlements processing on Base Sepolia (testnet)
- [ ] Fee split configurable (Arkova receives payment)
- [ ] Health check endpoint
- [ ] Transaction logs queryable

### PH1-PAY-03: Payment Analytics & Revenue Tracking
**Priority:** P1 | **Effort:** 1 day | **Depends on:** PH1-PAY-01

- Admin dashboard: x402 revenue per day/week/month
- Per-endpoint revenue breakdown
- Top payers (by address)
- Settlement status tracking

---

## WORKSTREAM 3: INTELLIGENCE FOUNDATION (Nessie RAG)

### PH1-INT-01: Vector DB Enhancement for Public Records
**Priority:** P0 | **Effort:** 2 days | **Depends on:** Migration 0077

Extend existing pgvector infrastructure to support public records:
- New migration: `public_record_embeddings` table (separate from credential_embeddings)
- Embedding generation job for public records (Jina v3 recommended, Gemini text-embedding-004 as fallback)
- Batch embedding pipeline: process 1000 records at a time
- Index: IVFFlat for cosine similarity

**Acceptance Criteria:**
- [ ] Migration: public_record_embeddings table with vector(768) column
- [ ] Batch embedding job processes unembedded public records
- [ ] Uses existing AI provider abstraction
- [ ] RPC: `search_public_record_embeddings(query_embedding, threshold, limit)`
- [ ] Switchboard flag: `ENABLE_PUBLIC_RECORD_EMBEDDINGS`

### PH1-INT-02: RAG Retrieval Endpoint
**Priority:** P0 | **Effort:** 3 days | **Depends on:** PH1-INT-01

New endpoint: `GET /api/v1/nessie/query`
- Accepts natural language query
- Generates query embedding
- Retrieves top-K relevant documents from public_record_embeddings
- Returns results with Bitcoin anchor proofs (Merkle proof + tx ID)
- Each result includes: source_url, record_type, relevance_score, anchor_proof

**Acceptance Criteria:**
- [ ] Endpoint accepts query string, returns ranked results
- [ ] Each result includes verifiable Bitcoin anchor proof
- [ ] Confidence scoring on results
- [ ] x402 payment integration ($0.01/query)
- [ ] Rate limited: 30 req/min per user
- [ ] Unit tests

### PH1-INT-03: Gemini RAG Integration
**Priority:** P1 | **Effort:** 2 days | **Depends on:** PH1-INT-02

Connect RAG retrieval to existing Gemini AI processing:
- Query → retrieve relevant anchored documents → feed as context to Gemini
- Gemini generates answer with citations to specific anchored documents
- Each citation includes verifiable proof link
- Client-side: existing Gemini integration gets "verified context" mode

**Acceptance Criteria:**
- [ ] Gemini receives retrieved documents as context
- [ ] Responses include citations with anchor proof links
- [ ] Confidence score on each citation
- [ ] Falls back to general Gemini if no relevant docs found

---

## WORKSTREAM 4: AGENT SDK & INTEGRATIONS

### PH1-SDK-01: TypeScript SDK (@arkova/sdk)
**Priority:** P1 | **Effort:** 3 days | **Depends on:** PH1-PAY-01

Minimal SDK wrapping the verification API:
```typescript
import { Arkova } from '@arkova/sdk';
const arkova = new Arkova({ apiKey: 'ak_...' });

// Anchor
const receipt = await arkova.anchor(data);

// Verify
const result = await arkova.verify(data, receipt);
// result.verified === true, result.proof includes Bitcoin tx
```

- x402 payment built in (auto-pays on verify calls)
- TypeScript-first with full type definitions
- Works in Node.js and browser (client-side fingerprinting)
- Published to npm

**Acceptance Criteria:**
- [ ] `arkova.anchor(data)` returns receipt
- [ ] `arkova.verify(data, receipt)` returns verification result with proof
- [ ] x402 integration: auto-payment on verify
- [ ] API key authentication
- [ ] TypeScript types exported
- [ ] README with examples
- [ ] Published to npm (scoped @arkova/sdk)

### PH1-SDK-02: Python SDK (arkova-python)
**Priority:** P2 | **Effort:** 2 days | **Depends on:** PH1-PAY-01

Same API surface as TypeScript SDK but for Python:
```python
from arkova import Arkova
client = Arkova(api_key="ak_...")
receipt = client.anchor(data)
result = client.verify(data, receipt)
```

### PH1-SDK-03: MCP Server Enhancement
**Priority:** P1 | **Effort:** 2 days | **Depends on:** PH1-INT-02

Add tools to existing MCP server at edge.arkova.ai:
- `nessie_query` — RAG query with verified citations
- `anchor_document` — Anchor a document hash
- `verify_document` — Verify by hash
- `compliance_check` — Cross-reference against regulatory corpus (future)

---

## WORKSTREAM 5: UI ALIGNMENT WITH MARKETING SITE

### PH1-UI-01: Design System Refresh — Match arkova.ai
**Priority:** P0 | **Effort:** 2 days | **Depends on:** None

The marketing site (arkova.ai) has evolved past the current app aesthetic. Key differences:
- **Cards:** Marketing uses subtle border-glow cards (thin cyan border, dark fill, no heavy bg). App has chunky filled rectangles with visible bg contrast.
- **Typography:** Marketing uses bolder, more spacious headings with Space Grotesk for impact text. App headings feel smaller and tighter.
- **Spacing:** Marketing has generous whitespace. App feels cramped.
- **Glow effects:** Marketing has subtle cyan glow on card borders and CTAs. App has flat solid borders.
- **Auth page:** Login card uses heavy gray fill. Should match marketing's cleaner, more transparent style.

**Components to update:**
- StatCard (dashboard) — remove heavy bg fill, use border-glow style
- AuthLayout / login page — lighter card, more breathing room
- Sidebar — verify it matches marketing nav feel
- DashboardPage — heading sizes, spacing
- All card-style components — consistent border-glow treatment

**Acceptance Criteria:**
- [ ] StatCards use subtle border-glow (thin cyan border, transparent/near-transparent fill)
- [ ] Auth pages match marketing site's clean, spacious feel
- [ ] Dashboard headings use Space Grotesk at larger sizes
- [ ] Consistent spacing/padding matching marketing site
- [ ] UAT at 1280px and 375px
- [ ] Screenshots confirm visual alignment with arkova.ai

---

## DEPENDENCY MAP

```
Migration 0077 (PR #126) ──┬── PH1-DATA-01 (EDGAR enhance)
                           ├── PH1-DATA-02 (USPTO)
                           ├── PH1-DATA-03 (Federal Register)
                           └── PH1-INT-01 (Vector DB)
                                    │
PH1-DATA-01 ───────────────── PH1-DATA-04 (Merkle batch anchoring)
                                    │
PH1-INT-01 ────────────────── PH1-INT-02 (RAG endpoint)
                                    │
PH1-INT-02 ───────────────┬── PH1-INT-03 (Gemini RAG)
                          └── PH1-SDK-03 (MCP enhancement)

Migration 0078 (PR #125) ──── PH1-PAY-01 (x402 middleware)
                                    │
PH1-PAY-01 ───────────────┬── PH1-PAY-02 (Facilitator)
                          ├── PH1-PAY-03 (Analytics)
                          ├── PH1-SDK-01 (TS SDK)
                          └── PH1-SDK-02 (Python SDK)

PH1-UI-01 ────────────────── No dependencies (parallel)
```

---

## POTENTIAL BUGS & GAPS

### Known Risks
1. **EDGAR API instability** — SEC may change rate limits or endpoints. Mitigation: bulk download fallback, monitor API health.
2. **x402 package maturity** — @x402/* packages are relatively new. Mitigation: integration tests, fallback to API key auth.
3. **Embedding model version drift** — If Gemini text-embedding-004 changes dimensions, existing embeddings break. Mitigation: version column in embeddings table.
4. **Merkle batch size tuning** — Too large = slow tree construction, too small = expensive on-chain. Need benchmarks.
5. **Public records PII** — SEC filings may contain personal information (officers, directors). Mitigation: PII detection in ingestion pipeline.
6. **CORS for x402** — x402 facilitator calls from browser may hit CORS issues. Need proxy or server-side settlement.

### Gaps Identified
1. **No data quality scoring** — Ingested records need quality/completeness scoring before training export
2. **No deduplication** — Records from multiple sources may overlap (e.g., SEC filing referenced in Federal Register)
3. **No ingestion rate monitoring** — Need alerts if pipeline stalls
4. **No cost alerting** — Bitcoin anchoring costs could spike unexpectedly at scale
5. **No public_records RLS for org-scoped access** — Currently service_role only; future may need org-level access

---

## SPRINT PLAN

### Sprint P1.5-S1: Foundation (Days 1-3)
- PH1-UI-01: Design system refresh (match arkova.ai)
- PH1-DATA-01: EDGAR full-text fetcher enhancement
- PH1-DATA-02: USPTO patent fetcher

### Sprint P1.5-S2: Anchoring + Payments (Days 4-6)
- PH1-DATA-04: Merkle batch anchoring for public records
- PH1-PAY-01: x402 Express middleware integration
- PH1-DATA-03: Federal Register fetcher

### Sprint P1.5-S3: Intelligence + SDK (Days 7-9)
- PH1-INT-01: Vector DB enhancement
- PH1-INT-02: RAG retrieval endpoint
- PH1-PAY-02: Self-hosted facilitator setup

### Sprint P1.5-S4: Integration + Polish (Days 10-12)
- PH1-INT-03: Gemini RAG integration
- PH1-SDK-01: TypeScript SDK
- PH1-SDK-03: MCP server enhancement
- PH1-DATA-05: Pipeline monitoring dashboard
- PH1-PAY-03: Payment analytics

---

## DECISION GATES

| Gate | Timing | Criteria | If Yes | If No |
|------|--------|----------|--------|-------|
| Gate 1 | Month 3 | >50K queries/mo, >20 active beta users | Proceed to Phase 2, hire ML team | Extend Phase 1, focus on distribution |
| Gate 2 | Month 8 | >200K queries/mo, >10 enterprise leads | Proceed to Phase 3, scale inference | Optimize Phase 2, defer enterprise |
| Gate 3 | Month 12 | >$100K MRR, positive unit economics | Raise dedicated AI fund, expand team | Maintain current scale, optimize costs |
