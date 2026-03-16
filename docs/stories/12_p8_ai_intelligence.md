# P8 AI Intelligence — Story Documentation
_Last updated: 2026-03-15 ~11:45 PM EST | 15/19 stories COMPLETE, 4/19 NOT STARTED_

## Group Overview

P8 AI Intelligence delivers AI-powered credential extraction, fraud analysis, semantic search, and agentic verification. All stories respect **Constitution 4A** — document bytes and raw OCR text never leave the client. Only PII-stripped structured metadata flows to server-side AI.

The group is split into three phases using **Option C (Hybrid) phasing**:

| Phase | Stories | Points (est.) | Description |
|-------|---------|---------------|-------------|
| Phase I (Go-Live Blockers) | 7 | ~34 | Core AI infrastructure + extraction pipeline |
| Phase 1.5 | 6 | — | Semantic search + batch AI + agentic verification |
| Phase II | 6 | — | Learning, fraud analysis, reporting |

**Feature flags:**
- `ENABLE_AI_EXTRACTION` — gates all AI extraction endpoints and client-side AI pipeline (default: `false`)
- `ENABLE_SEMANTIC_SEARCH` — gates pgvector search endpoints (default: `false`)
- `ENABLE_AI_FRAUD` — gates fraud analysis pipeline (default: `false`)

**Provider abstraction:** All AI calls go through `IAIProvider` interface supporting Gemini, OpenAI, and Anthropic with hot-swap via `AI_PROVIDER` env var. Gemini path uses **Vertex AI ADK** (`GeminiADKProvider` with sub-agents) by default, with direct SDK fallback. Non-Gemini providers use direct SDK calls. ADK agents deploy to **Vertex AI Agent Engine** (Google Cloud startup credits).

## Architecture Context

**Client-Side Pipeline (Constitution 4A compliant):**
```
Document (user device)
  → PDF.js / Tesseract.js (Web Worker, client-side)
  → Raw OCR text (client-only, never sent to server)
  → PII Stripping (regex: SSN, student IDs, DOB, emails, phones, names)
  → PII-stripped structured metadata + fingerprint
  → Server API (POST /api/v1/ai/extract)
  → IAIProvider (Gemini Flash / OpenAI / Anthropic)
  → Structured credential fields returned to client
```

**Server-Side AI (metadata only):**
```
services/worker/src/
  ai/
    provider.ts           # IAIProvider interface + factory
    gemini.ts             # GeminiProvider (direct SDK — fallback path)
    gemini-adk.ts         # GeminiADKProvider (Vertex AI ADK — recommended)
    openai.ts             # OpenAI implementation (Phase 1.5+)
    anthropic.ts          # Anthropic implementation (Phase 1.5+)
    extraction.ts         # Credential extraction service
    embeddings.ts         # Embedding generation (Phase 1.5+)
    fraud.ts              # Fraud analysis (Phase II)
    cost-tracker.ts       # Token/credit usage tracking
    adk/                  # ADK agent definitions (Gemini path only)
      extraction-agent.ts # MetadataExtractionAgent (P8-S4)
      description-agent.ts# DescriptionAgent (P8-S5)
      anomaly-agent.ts    # AnomalyDetectionAgent (P8-S7)
      duplicate-agent.ts  # DuplicateDetectionAgent (P8-S8)
      classify-agent.ts   # ClassificationAgent (P8-S14)
  middleware/
    aiFeatureGate.ts      # ENABLE_AI_EXTRACTION enforcement
```

**Vertex AI ADK Architecture (Gemini path):**
```
IAIProvider interface (unchanged — all providers implement this)
  ├── GeminiADKProvider ← RECOMMENDED: Uses ADK LlmAgent + Vertex AI Agent Engine
  │   ├── MetadataExtractionAgent (P8-S4)
  │   ├── DescriptionAgent (P8-S5)
  │   ├── AnomalyDetectionAgent (P8-S7)
  │   ├── DuplicateDetectionAgent (P8-S8)
  │   └── ClassificationAgent (P8-S14)
  ├── GeminiProvider (direct SDK — simpler, fallback if ADK unavailable)
  ├── OpenAIProvider (Phase 1.5+)
  └── AnthropicProvider (Phase 1.5+)
```

ADK is used **only** for the Gemini path. IAIProvider wraps all providers including ADK. Non-Gemini providers use direct SDK calls. ADK agents deploy to **Vertex AI Agent Engine** (covered by Google Cloud startup credits).

**PII Stripping (client-side only):**
```
src/lib/
  piiStripper.ts          # Regex-based PII removal
  ocrWorker.ts            # Web Worker for PDF.js + Tesseract.js
  aiExtraction.ts         # Client-side orchestration
```

**Credits System (hybrid model):**
- Monthly credit allocations per subscription tier (not unlimited)
- Credits track AI operations (extraction, search, fraud analysis)
- Overage blocked or charged per-unit depending on tier
- `ai_credits` table tracks monthly usage per org

## Dependency Chain

```
Phase I (Go-Live Blockers):
1. P8-S1  (Gemini API integration + IAIProvider)    ← No dependencies
2. P8-S2  (Cost tracking + credits schema)          ← P8-S1
3. P8-S3  (Feature flags)                           ← None
4. P8-S17 (Provider abstraction)                    ← P8-S1
5. P8-S18 (PII stripping library)                   ← None (client-side)
6. P8-S4  (Extraction service)                      ← P8-S1, S2, S3, S17, S18
7. P8-S5  (Extraction UI)                           ← P8-S4, S18

Phase 1.5:
8.  P8-S10 (pgvector extension + schema)            ← P8-S4
9.  P8-S11 (Embedding generation)                   ← P8-S10, S17
10. P8-S12 (Semantic search UI)                     ← P8-S11
11. P8-S13 (Batch AI processing)                    ← P8-S4
12. P8-S14 (Batch AI dashboard)                     ← P8-S13
13. P8-S19 (Agentic verification endpoint)          ← P8-S11

Phase II:
14. P8-S6  (Extraction learning/feedback)           ← P8-S4
15. P8-S7  (Fraud analysis engine)                  ← P8-S4, S11
16. P8-S8  (Integrity score UI)                     ← P8-S7
17. P8-S9  (Human review workflow)                  ← P8-S7
18. P8-S15 (AI report generation)                   ← P8-S7, S11
19. P8-S16 (Report UI)                              ← P8-S15
```

## Environment Variables (Required)

```bash
# AI Provider (worker only)
AI_PROVIDER=gemini                    # gemini | openai | anthropic
AI_GEMINI_MODE=adk                   # adk (default, recommended) | direct (SDK fallback)
GEMINI_API_KEY=                       # Google AI Studio key
GOOGLE_CLOUD_PROJECT=                 # GCP project for Vertex AI Agent Engine (ADK deployment)
OPENAI_API_KEY=                       # OpenAI key (Phase 1.5+)
ANTHROPIC_API_KEY=                    # Anthropic key (Phase 1.5+)

# Feature Flags
ENABLE_AI_EXTRACTION=false            # Gates all AI extraction
ENABLE_SEMANTIC_SEARCH=false          # Gates pgvector search
ENABLE_AI_FRAUD=false                 # Gates fraud analysis

# Cost Controls
AI_MONTHLY_CREDIT_FREE=50            # Free tier monthly credits
AI_MONTHLY_CREDIT_PRO=500            # Pro tier monthly credits
AI_MONTHLY_CREDIT_ENTERPRISE=5000    # Enterprise tier monthly credits
AI_COST_PER_EXTRACTION=1             # Credits per extraction call
AI_COST_PER_SEARCH=1                 # Credits per semantic search
AI_COST_PER_FRAUD_CHECK=5            # Credits per fraud analysis
```

---

## Stories

---

### P8-S1: Gemini API Integration + IAIProvider Interface

**Phase:** I (Go-Live Blocker)
**Status:** COMPLETE
**Completed:** 2026-03-15 (PR #68). `GeminiProvider` implementing `IAIProvider` with circuit breaker (5 failures → 60s cooldown), exponential backoff retry (3 attempts, 500ms base), structured JSON output via `@google/generative-ai`. Zod schemas in `ai/schemas.ts`, prompt templates in `ai/prompts/extraction.ts`. 13 tests.
**Dependencies:** None
**Estimated Points:** 5

#### User Story

As a developer, I need a provider-agnostic AI interface so that the platform can call Gemini (or another LLM) for credential extraction without coupling to a single vendor.

#### What This Story Delivers

- `IAIProvider` TypeScript interface with `extract()`, `classify()`, and `embed()` methods
- **Recommended Gemini implementation: `GeminiADKProvider`** using Vertex AI ADK (`@google/adk`) with `LlmAgent` abstraction, deployable to Vertex AI Agent Engine (covered by Google Cloud startup credits)
- Fallback Gemini implementation: `GeminiProvider` using direct `@google/generative-ai` SDK (simpler, for environments where ADK is unavailable)
- Structured prompt templates for credential extraction
- Error handling with retries and circuit breaker pattern
- Request/response Zod schemas

#### Implementation Tasks

- [ ] Create `services/worker/src/ai/provider.ts` — `IAIProvider` interface
- [ ] Create `services/worker/src/ai/gemini-adk.ts` — `GeminiADKProvider` class (recommended, uses ADK `LlmAgent`)
- [ ] Create `services/worker/src/ai/gemini.ts` — `GeminiProvider` class (direct SDK fallback)
- [ ] Create `services/worker/src/ai/prompts/extraction.ts` — prompt templates
- [ ] Create `services/worker/src/ai/schemas.ts` — Zod request/response schemas
- [ ] Add `@google/adk` + `@google/generative-ai` dependencies to worker `package.json`
- [ ] Unit tests for prompt generation, response parsing, error handling
- [ ] Mock provider for tests (`services/worker/src/ai/mock.ts`)

#### Acceptance Criteria

- [ ] `IAIProvider` interface defined with `extract()`, `classify()`, `embed()` methods
- [ ] `GeminiProvider` implements `IAIProvider` using Gemini Flash model
- [ ] Structured JSON output from extraction calls (credential type, issuer, dates, fields)
- [ ] Retry logic with exponential backoff (3 attempts, 1s/2s/4s)
- [ ] Circuit breaker opens after 5 consecutive failures
- [ ] All prompts are version-tagged for reproducibility
- [ ] Mock provider passes same test suite as real provider
- [ ] 90%+ test coverage on provider code

#### Definition of Done

- [ ] IAIProvider interface + GeminiProvider + MockProvider implemented
- [ ] Unit tests passing with 90%+ coverage
- [ ] No real Gemini API calls in test suite
- [ ] `typecheck` + `lint` + `test` green

---

### P8-S2: AI Cost Tracking + Credits Schema

**Phase:** I (Go-Live Blocker)
**Status:** COMPLETE
**Completed:** 2026-03-15 (PR #68). Migration 0059 (`ai_credits` + `ai_usage_events` tables with RLS). `cost-tracker.ts` with `checkAICredits`/`deductAICredits`/`logAIUsageEvent`. SECURITY DEFINER RPCs (`check_ai_credits`, `deduct_ai_credits`). `GET /api/v1/ai/usage` endpoint. Credit allocations: Free=50, Pro=500, Enterprise=5000/month. 17 tests (15 cost-tracker + 2 usage endpoint).
**Dependencies:** P8-S1
**Estimated Points:** 5

#### User Story

As an org admin, I need to see how many AI credits my organization has used this month so I can manage costs and stay within our plan's allocation.

#### What This Story Delivers

- `ai_credits` table tracking monthly credit usage per org
- `ai_usage_events` table logging individual AI operations
- Monthly credit allocation per subscription tier (hybrid model — not unlimited)
- Credit check middleware blocking requests when quota exhausted
- Usage reporting endpoint

#### Implementation Tasks

- [ ] Migration: `ai_credits` table (org_id, month, credits_used, credits_limit, last_reset_at)
- [ ] Migration: `ai_usage_events` table (id, org_id, event_type, credits_consumed, model_used, tokens_in, tokens_out, cost_usd, created_at)
- [ ] RLS policies (org-scoped read, service_role write)
- [ ] `services/worker/src/ai/cost-tracker.ts` — credit check + decrement + logging
- [ ] Credit allocation seeded per tier: Free=50, Pro=500, Enterprise=5000/month
- [ ] Middleware: `checkAICredits()` returns 429 when exhausted with upgrade URL
- [ ] GET `/api/v1/ai/usage` endpoint returning current month stats
- [ ] Unit tests for credit tracking, quota enforcement, monthly reset

#### Acceptance Criteria

- [ ] `ai_credits` table created with RLS (org-scoped)
- [ ] `ai_usage_events` table created with RLS
- [ ] Monthly credit limits enforced per subscription tier
- [ ] Credits reset on 1st of each month
- [ ] HTTP 429 returned when credits exhausted (includes `upgrade_url`)
- [ ] Every AI operation logged to `ai_usage_events` with token counts and USD cost
- [ ] GET `/api/v1/ai/usage` returns: used, limit, remaining, reset_date, breakdown by operation type
- [ ] Credit allocations configurable via env vars

#### Definition of Done

- [ ] Migrations applied, types regenerated
- [ ] Cost tracker + middleware + endpoint implemented
- [ ] Unit tests passing
- [ ] Seed data includes credit allocations for demo orgs
- [ ] `typecheck` + `lint` + `test` green

---

### P8-S3: AI Feature Flags

**Phase:** I (Go-Live Blocker)
**Status:** COMPLETE
**Completed:** 2026-03-15 (PR #68). Three flags added to switchboard + seed SQL. `aiFeatureGate.ts` middleware with TTL-cached flag reads (60s). `aiExtractionGate()`, `semanticSearchGate()`, `aiFraudGate()` factory functions. Client-side guard functions in `switchboard.ts`. 17 tests.
**Dependencies:** None
**Estimated Points:** 2

#### User Story

As a platform operator, I need feature flags to enable/disable AI capabilities independently so I can roll out AI features gradually.

#### What This Story Delivers

- Three new switchboard flags: `ENABLE_AI_EXTRACTION`, `ENABLE_SEMANTIC_SEARCH`, `ENABLE_AI_FRAUD`
- Express middleware gating AI endpoints behind flags
- Client-side flag checks hiding AI UI when disabled

#### Implementation Tasks

- [ ] Seed `ENABLE_AI_EXTRACTION`, `ENABLE_SEMANTIC_SEARCH`, `ENABLE_AI_FRAUD` into `switchboard_flags` (all default `false`)
- [ ] Create `services/worker/src/middleware/aiFeatureGate.ts`
- [ ] Update `src/lib/switchboard.ts` to expose new flags
- [ ] Client-side conditional rendering for AI extraction UI
- [ ] Unit tests for middleware (flag on/off → 200/503)

#### Acceptance Criteria

- [ ] Three flags added to `switchboard_flags` (default: false)
- [ ] Middleware returns 503 for AI endpoints when respective flag is false
- [ ] Flags can be toggled without restart
- [ ] Client-side UI hides AI features when flag is false

#### Definition of Done

- [ ] Flags seeded, middleware created, client checks wired
- [ ] Unit tests passing
- [ ] `typecheck` + `lint` + `test` green

---

### P8-S17: AI Provider Abstraction (Multi-Provider)

**Phase:** I (Go-Live Blocker)
**Status:** COMPLETE
**Completed:** 2026-03-14 (PR #31). `IAIProvider` interface, `CloudflareAIFallbackProvider`, factory, mock, 16 tests in `services/worker/src/ai/`.
**Dependencies:** P8-S1
**Estimated Points:** 3

#### User Story

As a platform operator, I need to swap between AI providers (Gemini, OpenAI, Anthropic) without code changes so I can optimize for cost, performance, or availability.

#### What This Story Delivers

- Provider factory function selecting implementation based on `AI_PROVIDER` env var
- **ADK wraps the Gemini path:** When `AI_PROVIDER=gemini` (default), factory returns `GeminiADKProvider` which uses Vertex AI ADK under the hood. Fallback to direct `GeminiProvider` via `AI_GEMINI_MODE=direct` env var.
- OpenAI and Anthropic stub implementations (interface-compliant, not yet functional) — these use direct SDK calls, NOT ADK
- Provider health check endpoint
- Hot-swap support (change env var → new requests use new provider)

#### Implementation Tasks

- [ ] Create `services/worker/src/ai/factory.ts` — provider factory (routes `gemini` → ADK by default, `gemini-direct` → SDK fallback)
- [ ] Create `services/worker/src/ai/openai.ts` — stub implementing `IAIProvider`
- [ ] Create `services/worker/src/ai/anthropic.ts` — stub implementing `IAIProvider`
- [ ] GET `/api/v1/ai/health` endpoint (provider name, status, latency)
- [ ] Unit tests for factory routing, fallback behavior, ADK→direct fallback

#### Acceptance Criteria

- [ ] Factory returns correct provider based on `AI_PROVIDER` env var
- [ ] Gemini is default when env var is unset; uses `GeminiADKProvider` by default
- [ ] `AI_GEMINI_MODE=direct` forces fallback to `GeminiProvider` (direct SDK, no ADK)
- [ ] OpenAI/Anthropic stubs throw `NotImplementedError` with clear message
- [ ] Health endpoint returns provider name, mode (ADK/direct), and status
- [ ] Provider swap requires no restart (reads env on each request)

#### Definition of Done

- [ ] Factory + stubs + health endpoint implemented
- [ ] Unit tests passing
- [ ] `typecheck` + `lint` + `test` green

---

### P8-S18: Client-Side PII Stripping Library

**Phase:** I (Go-Live Blocker)
**Status:** COMPLETE
**Completed:** 2026-03-15 (PR #68). `src/lib/piiStripper.ts` with `stripPII()` function. Regex patterns for SSN, email, phone, DOB (context-aware — only after keywords), student ID (context-aware). Name matching against recipient fields. Returns `StrippingReport` with category counts. Constitution 4A compliant — client-side only. 27 tests.
**Dependencies:** None (client-side only)
**Estimated Points:** 5

#### User Story

As a user, I need confidence that my personal information is removed before any document data is sent for AI processing, preserving the platform's privacy guarantee.

#### What This Story Delivers

- `src/lib/piiStripper.ts` — regex-based PII detection and removal
- PII categories: SSN, student IDs, DOB, email addresses, phone numbers, names (matched against recipient fields)
- Configurable stripping levels (strict = replace all matches, lenient = flag only)
- Stripping report showing what was removed (categories + count, never values)
- 100% client-side — never imported in worker

#### Implementation Tasks

- [ ] Create `src/lib/piiStripper.ts` with `stripPII()` function
- [ ] Implement regex patterns for: SSN (XXX-XX-XXXX), phone (10+ digits), email, DOB (MM/DD/YYYY variants), student ID (configurable pattern)
- [ ] Name matching: compare against recipient name fields, redact matches
- [ ] Return `StrippingReport` with categories found, count per category, sanitized text
- [ ] Ensure `piiStripper.ts` is NEVER imported in `services/worker/` (add to lint rule)
- [ ] Unit tests with synthetic PII data (never real PII in tests)
- [ ] Edge cases: PII spanning line breaks, PII in tables, partial matches

#### Acceptance Criteria

- [ ] `stripPII()` removes SSN, phone, email, DOB, student ID, recipient names
- [ ] Replacements use category placeholders: `[SSN_REDACTED]`, `[PHONE_REDACTED]`, etc.
- [ ] `StrippingReport` returned with category counts (never the actual PII values)
- [ ] Strict mode: all matches replaced. Lenient mode: flagged but preserved.
- [ ] Zero false negatives on standard format PII (SSN: XXX-XX-XXXX, phone: (XXX) XXX-XXXX)
- [ ] Never imported in worker code (lint rule enforced)
- [ ] 95%+ test coverage

#### Definition of Done

- [ ] PII stripping library implemented and tested
- [ ] Lint rule prevents worker import
- [ ] Unit tests passing with 95%+ coverage
- [ ] `typecheck` + `lint` + `test` green

---

### P8-S4: AI Credential Extraction Service

**Phase:** I (Go-Live Blocker)
**Status:** COMPLETE
**Completed:** 2026-03-15 (PR #68). `POST /api/v1/ai/extract` endpoint. Auth required (JWT), Zod validation (`ExtractionRequestSchema`), credit check (402 if insufficient), AI provider call via `createAIProvider()`, credit deduction, audit logging via `logAIUsageEvent`. Feature-gated behind `ENABLE_AI_EXTRACTION`. Returns `{ fields, confidence, provider, creditsRemaining }`. Mounted in `router.ts` with `aiExtractionGate()` + `requireAuth`. 6 tests.
**Dependencies:** P8-S1, S2, S3, S17, S18
**Estimated Points:** 8

#### User Story

As an issuer, I want the system to automatically extract credential fields from my uploaded document so I don't have to manually type every field.

#### What This Story Delivers

- POST `/api/v1/ai/extract` endpoint accepting PII-stripped metadata
- Extraction pipeline: receive metadata → call IAIProvider → return structured fields
- Field mapping to credential schema (credential_type, issuer, dates, metadata JSONB)
- Confidence scores per field
- Credit deduction per extraction call

#### Implementation Tasks

- [ ] Create `services/worker/src/ai/extraction.ts` — extraction service
- [ ] Create POST `/api/v1/ai/extract` route
- [ ] Zod schema for extraction request (pii_stripped_text, document_fingerprint, hint_credential_type)
- [ ] Zod schema for extraction response (fields[], confidence_scores, suggested_credential_type)
- [ ] Wire credit deduction via cost-tracker
- [ ] Feature flag gate (`ENABLE_AI_EXTRACTION`)
- [ ] Audit log entry for each extraction
- [ ] Unit tests with mock provider
- [ ] Integration test: full pipeline with mock

#### Acceptance Criteria

- [ ] POST `/api/v1/ai/extract` accepts PII-stripped metadata only
- [ ] Returns structured credential fields with confidence scores (0.0–1.0)
- [ ] Suggests `credential_type` from enum
- [ ] Deducts credits from org's monthly allocation
- [ ] Returns 429 when credits exhausted
- [ ] Gated behind `ENABLE_AI_EXTRACTION` flag (503 when off)
- [ ] Extraction logged to `ai_usage_events`
- [ ] Never receives or processes raw document bytes or OCR text

#### Definition of Done

- [ ] Extraction service + endpoint implemented
- [ ] Credit tracking wired
- [ ] Tests passing (mock provider)
- [ ] `typecheck` + `lint` + `test` green

---

### P8-S5: AI Extraction UI

**Phase:** I (Go-Live Blocker)
**Status:** COMPLETE
**Completed:** 2026-03-15 (PR #68). `src/lib/ocrWorker.ts` (PDF.js + Tesseract.js, auto-detect by MIME type), `src/lib/aiExtraction.ts` (orchestrator: OCR → stripPII → fetch /api/v1/ai/extract → ExtractionField[]), `src/components/anchor/AIFieldSuggestions.tsx` (Nordic Vault aesthetic, glass-card, confidence badges: green >0.9 / amber 0.7-0.9 / red <0.7, accept/reject/edit per field, credits remaining display). 18 tests (5 aiExtraction + 13 AIFieldSuggestions).
**Dependencies:** P8-S4, S18
**Estimated Points:** 5

#### User Story

As an issuer, I want to see AI-suggested fields after uploading a document, review them, and accept or correct them before creating the anchor.

#### What This Story Delivers

- Client-side OCR pipeline (PDF.js + Tesseract.js in Web Worker)
- PII stripping integration (calls `stripPII()` before any server call)
- AI suggestion UI showing extracted fields with confidence indicators
- Accept/reject/edit per field
- Integration into `SecureDocumentDialog` / `IssueCredentialForm` flow

#### Implementation Tasks

- [ ] Create `src/lib/ocrWorker.ts` — Web Worker wrapper for PDF.js + Tesseract.js
- [ ] Create `src/lib/aiExtraction.ts` — orchestration (OCR → strip → API call → render)
- [ ] Create `src/components/anchor/AIFieldSuggestions.tsx` — field suggestion UI
- [ ] Confidence badges: green (>0.9), amber (0.7–0.9), red (<0.7)
- [ ] Accept all / reject all / per-field edit buttons
- [ ] Loading state during OCR + AI processing
- [ ] Wire into `IssueCredentialForm` as optional step (only when flag enabled)
- [ ] Add `pdf.js` and `tesseract.js` dependencies
- [ ] Unit tests for orchestration logic
- [ ] Integration test: upload → OCR → strip → extract → suggest

#### Acceptance Criteria

- [ ] OCR runs entirely in browser (Web Worker)
- [ ] PII stripping occurs before any server communication
- [ ] User sees suggested fields with confidence indicators
- [ ] User can accept, reject, or edit each field
- [ ] Accepted fields populate the credential form
- [ ] Feature is hidden when `ENABLE_AI_EXTRACTION` flag is false
- [ ] Graceful fallback if OCR or AI fails (manual entry still works)

#### Definition of Done

- [ ] Client-side OCR + PII strip + AI suggestion UI implemented
- [ ] Wired into credential creation flow
- [ ] Tests passing
- [ ] `typecheck` + `lint` + `test` green

---

### P8-S10: pgvector Extension + Embedding Schema

**Phase:** 1.5
**Status:** COMPLETE
**Completed:** 2026-03-15 (PR TBD). Migration 0060 (`credential_embeddings` table, HNSW index, org-scoped RLS, 2 RPCs).
**Dependencies:** P8-S4
**Estimated Points:** 3

#### User Story

As a platform operator, I need vector storage infrastructure so credentials can be semantically searched.

#### What This Story Delivers

- `credential_embeddings` table with `vector(768)` column (pgvector already enabled in migration 0051)
- HNSW index for cosine similarity search (`hnsw_credential_embeddings` with `vector_cosine_ops`)
- RLS policies (org-scoped for internal search, public access for agentic verification of public anchors)
- `search_credential_embeddings` RPC (org-scoped, SECURITY DEFINER)
- `search_public_credential_embeddings` RPC (public anchors only, for agentic verification)

#### Implementation Files

- `supabase/migrations/0060_credential_embeddings.sql`

#### Acceptance Criteria

- [x] `pgvector` extension enabled (migration 0051, reused)
- [x] `credential_embeddings` table: id, anchor_id, org_id, embedding vector(768), model_version, source_text_hash, created_at, updated_at
- [x] HNSW index created for cosine similarity
- [x] RLS: users can only search their own org's embeddings
- [x] Public RPC for agentic verification (public anchors only)
- [x] Rollback comment in migration

---

### P8-S11: Embedding Generation Pipeline

**Phase:** 1.5
**Status:** COMPLETE
**Completed:** 2026-03-15 (PR TBD). `embeddings.ts` service + `ai-embed.ts` endpoint (POST /api/v1/ai/embed + batch). 18 tests (14 service + 4 endpoint).
**Dependencies:** P8-S10, S17
**Estimated Points:** 5

#### User Story

As a developer, I need embeddings generated for each credential's metadata so that semantic search can find similar or related credentials.

#### What This Story Delivers

- `embeddings.ts` service: `buildEmbeddingText()`, `generateEmbedding()`, `generateAndStoreEmbedding()`, `batchReEmbed()`
- POST `/api/v1/ai/embed` — single credential embedding
- POST `/api/v1/ai/embed/batch` — batch re-embedding for existing credentials
- Credit check/deduction per embedding operation
- SHA-256 source text hashing for dedup detection
- Usage event logging (non-blocking)

#### Implementation Files

- `services/worker/src/ai/embeddings.ts`
- `services/worker/src/ai/embeddings.test.ts`
- `services/worker/src/api/v1/ai-embed.ts`
- `services/worker/src/api/v1/ai-embed.test.ts`

#### Acceptance Criteria

- [x] Embeddings generated from PII-stripped credential metadata
- [x] Stored in `credential_embeddings` table (upsert by anchor_id)
- [x] Batch endpoint for re-embedding existing credentials
- [x] Credits deducted per embedding operation
- [x] Model version tracked per embedding
- [x] Source text hash stored for change detection

---

### P8-S12: Semantic Search UI

**Phase:** 1.5
**Status:** COMPLETE
**Completed:** 2026-03-15 (PR TBD). GET `/api/v1/ai/search` endpoint + `SemanticSearch` component + `useSemanticSearch` hook. 20 tests (5 endpoint + 7 hook + 8 component).
**Dependencies:** P8-S11
**Estimated Points:** 5

#### User Story

As an org admin, I want to search my credentials using natural language queries so I can find related documents without knowing exact field values.

#### What This Story Delivers

- GET `/api/v1/ai/search?q={query}` endpoint using pgvector cosine similarity
- Search results with relevance scores and credential details
- `SemanticSearch` component with Nordic Vault aesthetic (glass-card, shimmer, staggered reveals)
- `useSemanticSearch` hook with credit exhaustion / feature disabled handling
- SimilarityBadge color coding (green >90%, amber >75%, red otherwise)

#### Implementation Files

- `services/worker/src/api/v1/ai-search.ts`
- `services/worker/src/api/v1/ai-search.test.ts`
- `src/components/search/SemanticSearch.tsx`
- `src/components/search/SemanticSearch.test.tsx`
- `src/hooks/useSemanticSearch.ts`
- `src/hooks/useSemanticSearch.test.ts`

#### Acceptance Criteria

- [x] Natural language search across org's credentials
- [x] Results ranked by cosine similarity with relevance scores
- [x] Minimum similarity threshold (0.7 default)
- [x] Gated behind `ENABLE_SEMANTIC_SEARCH` flag
- [x] Credits deducted per search query
- [x] Results respect RLS (org-scoped via RPC)

---

### P8-S13: Batch AI Processing (Cloudflare Queues)

**Phase:** 1.5
**Status:** COMPLETE
**Completed:** 2026-03-14 (PR #31). `services/edge/src/batch-queue.ts` + `batch-queue-logic.ts` with Zod schema. 4 tests.
**Dependencies:** P8-S4
**Estimated Points:** 5

#### User Story

As an org admin uploading hundreds of credentials via CSV, I want AI to process them in bulk so I don't have to extract fields one at a time.

#### What This Story Delivers

- Batch extraction job processing CSV uploads through AI pipeline
- Queue-based processing with progress tracking
- Credit deduction per item in batch

#### Acceptance Criteria

- [ ] Batch job accepts array of PII-stripped metadata items
- [ ] Processing queued as worker job with progress tracking
- [ ] Per-item credit deduction
- [ ] Partial failure handling (some succeed, some fail)
- [ ] Batch status endpoint (queued, processing, complete, partial_failure)
- [ ] Rate limited to prevent API abuse

---

### P8-S14: Batch AI Dashboard

**Phase:** 1.5
**Status:** COMPLETE
**Completed:** 2026-03-15 (PR TBD). `BatchAIDashboard` component with Nordic Vault aesthetic. 5 tests.
**Dependencies:** P8-S13
**Estimated Points:** 3

#### User Story

As an org admin, I want to see the status of my batch AI processing jobs so I know when extraction is complete.

#### What This Story Delivers

- `BatchAIDashboard` component with glass-card styling, shimmer loading, staggered reveals
- Job list with StatusBadge (queued/processing/complete/partial_failure/failed)
- ProgressBar per job with success/failure breakdown
- Summary stats (completed, processing, failed counts)
- Auto-refresh every 5s while jobs are active

#### Implementation Files

- `src/components/dashboard/BatchAIDashboard.tsx`
- `src/components/dashboard/BatchAIDashboard.test.tsx`

#### Acceptance Criteria

- [x] Batch job list with status indicators (StatusBadge component)
- [x] Progress bar per active job (ProgressBar component)
- [x] Success/failure count per completed job
- [x] Auto-refresh while jobs are processing (5s interval)
- [x] Summary stats grid (completed/processing/failed)

---

### P8-S19: Agentic Verification Endpoint

**Phase:** 1.5
**Status:** COMPLETE
**Completed:** 2026-03-15 (PR TBD). GET `/api/v1/verify/search` endpoint with frozen schema results. 5 tests.
**Dependencies:** P8-S11
**Estimated Points:** 5

#### User Story

As an ATS/background check system, I need a search-based verification endpoint so I can find and verify credentials using natural language queries rather than exact IDs.

#### What This Story Delivers

- GET `/api/v1/verify/search?q={query}` endpoint
- Combines semantic search with verification status using `search_public_credential_embeddings` RPC
- Returns frozen schema results (ADR-001 HTTPS URIs) with similarity scores
- API key required (no anonymous access)
- Graceful fallback for missing RPC (error code 42883)

#### Implementation Files

- `services/worker/src/api/v1/ai-verify-search.ts`
- `services/worker/src/api/v1/ai-verify-search.test.ts`

#### Acceptance Criteria

- [x] GET `/api/v1/verify/search?q={query}` returns matching verified credentials
- [x] Results include frozen schema verification data
- [x] Relevance scores included (similarity field)
- [x] API key required (no anonymous access)
- [x] Gated behind `ENABLE_SEMANTIC_SEARCH` flag
- [x] Results are public credentials only (via `search_public_credential_embeddings` RPC)
- [x] Graceful fallback when RPC not yet deployed

---

### P8-S6: Extraction Learning / Feedback Loop

**Phase:** II
**Status:** NOT STARTED
**Dependencies:** P8-S4
**Estimated Points:** 5

#### User Story

As a platform operator, I want the AI extraction to improve over time based on user corrections so accuracy increases with usage.

#### What This Story Delivers

- Feedback collection when users correct AI-suggested fields
- Correction storage for fine-tuning prompt engineering
- Accuracy metrics per credential type

#### Acceptance Criteria

- [ ] User corrections stored with original AI suggestion and final value
- [ ] Accuracy metrics tracked per credential type
- [ ] Feedback accessible for prompt refinement
- [ ] No PII stored in feedback data

---

### P8-S7: Cloudflare Crawler (Institution Ingestion)

**Phase:** II
**Status:** COMPLETE
**Completed:** 2026-03-14 (PR #31). `services/edge/src/institution-crawler.ts` — crawls university credential program pages. 5 tests.
**Dependencies:** P8-S4, S11
**Estimated Points:** 8

#### User Story

As a verifier, I want AI-powered integrity scoring so I can identify potentially fraudulent or suspicious credentials.

#### What This Story Delivers

- Fraud analysis pipeline comparing credential metadata against known patterns
- Integrity score (0–100) per credential
- Anomaly detection using embedding similarity
- Flagging suspicious patterns (date inconsistencies, issuer mismatches)

#### Acceptance Criteria

- [ ] Integrity score generated per credential (0–100)
- [ ] Pattern checks: date logic, issuer validation, field consistency
- [ ] Embedding-based anomaly detection (outlier from org's credential cluster)
- [ ] Gated behind `ENABLE_AI_FRAUD` flag
- [ ] Credits deducted per fraud check (higher cost: 5 credits)
- [ ] Results stored for audit trail
- [ ] Never makes definitive fraud claims — scores and flags only

---

### P8-S8: Integrity Score UI

**Phase:** II
**Status:** NOT STARTED
**Dependencies:** P8-S7
**Estimated Points:** 3

#### User Story

As an org admin, I want to see integrity scores on my credentials dashboard so I can prioritize review of suspicious items.

#### What This Story Delivers

- Integrity score badge on credential cards
- Color-coded: green (80+), amber (50–79), red (<50)
- Click-through to detailed analysis

#### Acceptance Criteria

- [ ] Score badge visible on credential list and detail views
- [ ] Color-coded thresholds
- [ ] Detail view shows individual check results
- [ ] Hidden when `ENABLE_AI_FRAUD` is false

---

### P8-S9: Human Review Workflow

**Phase:** II
**Status:** NOT STARTED
**Dependencies:** P8-S7
**Estimated Points:** 5

#### User Story

As an org admin, I want a workflow to review AI-flagged credentials so that suspicious items are investigated before action is taken.

#### What This Story Delivers

- Review queue for credentials flagged by fraud analysis
- Approve / investigate / escalate actions
- Review decisions logged to audit trail

#### Acceptance Criteria

- [ ] Review queue showing flagged credentials sorted by integrity score
- [ ] Approve (clear flag), Investigate (add note), Escalate (notify admin) actions
- [ ] All review decisions logged to `audit_events`
- [ ] Reviewer identity tracked
- [ ] Queue filters by score range, credential type, date

---

### P8-S15: R2 Report Storage (Zero-Egress Signed URLs)

**Phase:** II
**Status:** COMPLETE
**Completed:** 2026-03-14 (PR #31). `services/edge/src/report-generator.ts` + `report-logic.ts`. R2 binding in wrangler.toml. 4 tests.
**Dependencies:** P8-S7, S11
**Estimated Points:** 5

#### User Story

As an org admin, I want AI-generated summary reports about my credential portfolio so I can present insights to stakeholders.

#### What This Story Delivers

- Report generation endpoint producing markdown/PDF summaries
- Portfolio analysis: credential counts by type, integrity distribution, issuance trends
- Semantic clustering of related credentials

#### Acceptance Criteria

- [ ] Report generation endpoint (POST `/api/v1/ai/reports`)
- [ ] Markdown and PDF output formats
- [ ] Includes: portfolio summary, integrity distribution, trend analysis
- [ ] Credits deducted per report
- [ ] Gated behind `ENABLE_AI_EXTRACTION` flag
- [ ] No PII in generated reports

---

### P8-S16: Report UI

**Phase:** II
**Status:** NOT STARTED
**Dependencies:** P8-S15
**Estimated Points:** 3

#### User Story

As an org admin, I want a reports page where I can generate, view, and download AI-powered portfolio reports.

#### What This Story Delivers

- Reports page at `/reports/ai`
- Report generation trigger with parameter selection
- Report history with download links

#### Acceptance Criteria

- [ ] Reports page accessible from sidebar
- [ ] Generate report button with date range and type filters
- [ ] Report history list with status, date, download link
- [ ] PDF download for completed reports
- [ ] Hidden when AI flags are disabled

---

## Architectural Decisions

| Decision | Rationale |
|----------|-----------|
| Constitution 4A (PII-stripped metadata exception) | Enables AI features while preserving core privacy guarantee |
| Option C hybrid phasing | 7 blockers ship with Phase I; semantic search and fraud follow |
| IAIProvider abstraction | Vendor independence; Google credits now, swap later |
| Vertex AI ADK for Gemini path | ADK `LlmAgent` provides structured multi-agent orchestration; deploys to Vertex AI Agent Engine (Google startup credits); ADK wraps Gemini only — IAIProvider wraps all providers including ADK |
| GeminiADKProvider with sub-agents | MetadataExtraction, Description, Anomaly, Duplicate, Classification agents — each maps to a P8 story; ADK Sequential/Parallel workflow agents for pipeline orchestration |
| Hybrid credits (not unlimited) | Prevents cost overrun; predictable per-tier pricing |
| Client-side OCR (Web Worker) | Document bytes never leave device; non-blocking UI |
| PII stripping mandatory (no bypass) | Compliance requirement; no "raw mode" even for admins |
| pgvector for semantic search | Native Postgres; no external vector DB dependency |
| HNSW index (not IVFFlat) | Better recall at query time; worth the build cost |
| Agentic verification via search | AI agents/ATS need natural language, not exact IDs |
| Credits per operation (not per token) | Simpler UX; predictable costs for users |

## Related Documentation

- [Constitution 4A](../../CLAUDE.md) — AI metadata exception in Section 1.6
- [12_verification_api.md](../confluence/12_verification_api.md) — API architecture (P4.5)
- [13_switchboard.md](../confluence/13_switchboard.md) — Feature flag configuration
- [08_payments_entitlements.md](../confluence/08_payments_entitlements.md) — Billing + credits
- [02_data_model.md](../confluence/02_data_model.md) — Schema reference

## Change Log

| Date | Change |
|------|--------|
| 2026-03-12 | Initial P8 story documentation created. 19 stories, Option C hybrid phasing. |
| 2026-03-12 | ADK architecture decision: Vertex AI ADK for Gemini path (GeminiADKProvider with sub-agents). Updated P8-S1, P8-S17, Architecture Context, Architectural Decisions table. |
| 2026-03-15 | P8 Phase I complete: P8-S1, S2, S3, S4, S5, S18 all COMPLETE (PR #68). 117+ new tests. Migration 0059 (ai_credits + ai_usage_events). 10/19 stories done (53%). |
