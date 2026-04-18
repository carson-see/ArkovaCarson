# Arkova — Technical & Security Wiki

**For Partners, Investors, and Integration Teams**
_Version 1.0 | March 2026 | Confidential_

---

## Table of Contents

1. [System Overview & Architecture](#1-system-overview--architecture)
2. [Security & Privacy (The Trust Section)](#2-security--privacy)
3. [Terminology & Compliance](#3-terminology--compliance)
4. [AI Intelligence Suite](#4-ai-intelligence-suite)
5. [Roadmap & Evolution](#5-roadmap--evolution)
6. [Developer Reference](#6-developer-reference)
7. [API Reference](#7-api-reference)
8. [Shared Responsibility Matrix](#8-shared-responsibility-matrix)

---

## 1. System Overview & Architecture

### What Arkova Is

Arkova is a **jurisdiction-aware verification layer** that enables organizations to issue, anchor, and verify credentials against the Bitcoin blockchain. It transforms documents such as diplomas, certificates, licenses, attestations, and compliance records into tamper-evident digital credentials — without ever taking custody of the underlying documents.

Arkova is **not** a blockchain company. It is a **verification infrastructure** company that uses Bitcoin as an immutable timestamping layer. The platform abstracts away all chain complexity, presenting a clean enterprise SaaS interface to issuers, holders, and verifiers.

### The Verification Layer Concept

Traditional credential verification relies on phone calls, manual lookups, and paper trails. Arkova replaces this with a three-party model:

```
┌─────────────┐          ┌─────────────┐          ┌─────────────┐
│   ISSUER    │  anchor   │   ARKOVA    │  verify   │  VERIFIER   │
│ (University,│ ────────► │ Verification│ ◄──────── │ (Employer,  │
│  Employer,  │          │   Layer     │          │  Regulator, │
│  Regulator) │          │             │          │  Partner)   │
└─────────────┘          └─────────────┘          └─────────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │    BITCOIN      │
                     │  (Immutable     │
                     │   Timestamp)    │
                     └─────────────────┘
```

**How it works:**

1. The **Issuer** uploads or creates a credential. The document is fingerprinted (SHA-256) entirely on the user's device. Only the fingerprint — never the document — leaves the browser.
2. Arkova **anchors** the fingerprint to Bitcoin via an `OP_RETURN` output containing a 36-byte payload (`ARKV` prefix + SHA-256 hash).
3. Any **Verifier** (employer, regulator, AI agent, ATS system) can query Arkova's API or public verification page to confirm the credential's authenticity, timestamp, issuer, and status.

### Non-Custodial Architecture

Arkova is **strictly non-custodial** across three dimensions:

| Dimension | What This Means |
|-----------|----------------|
| **Document Non-Custody** | Documents never leave the user's device. Arkova never receives, stores, transmits, or processes raw document content. Only a one-way SHA-256 fingerprint is stored. |
| **Financial Non-Custody** | Arkova does not store, accept, or manage user cryptocurrency. All on-chain fees are paid from an Arkova-managed corporate fee account. Users never interact with chain economics. |
| **Key Non-Custody** | Treasury signing keys are secured in GCP Cloud KMS (HSM-backed). No human has access to raw private key material. |

This design eliminates regulated data custody risk. Arkova does not become a custodian of PII, financial assets, or cryptographic material — removing exposure to GDPR data processor obligations, money transmitter classification, and key management liability.

### Schema-First Build Philosophy

Every feature begins at the database layer:

1. **Schema First** — Define Postgres tables, columns, constraints, and Row Level Security policies before writing any application code.
2. **Migration Immutability** — Once a migration is applied, it is never modified. Changes are expressed as compensating migrations.
3. **Type Generation** — TypeScript types are auto-generated from the database schema, ensuring compile-time safety across the full stack.
4. **Validation at the Boundary** — All write paths are validated with Zod schemas before reaching the database. No trust is placed in client-supplied data.

This philosophy ensures the database is always the single source of truth, type drift is impossible, and schema evolution is auditable.

---

## 2. Security & Privacy

### Mandatory Row Level Security (RLS)

Every table in the Arkova database has `FORCE ROW LEVEL SECURITY` enabled. This is a non-negotiable architectural constraint — there are no exceptions.

**What this means in practice:**

- Even if application code has a bug, the database will refuse to return rows the authenticated user is not authorized to see.
- `FORCE ROW LEVEL SECURITY` means RLS policies apply even to the table owner — a defense-in-depth measure against privilege escalation.
- All `SECURITY DEFINER` functions include `SET search_path = public` to prevent search path injection attacks.

**RLS Policy Summary (20+ tables):**

| Table | Policy |
|-------|--------|
| `anchors` | Users see own anchors + org anchors (via org membership) |
| `profiles` | Users see own profile only |
| `organizations` | Members see their own org |
| `audit_events` | Users see own events only |
| `api_keys` | ORG_ADMIN only (not readable by ORG_MEMBER) |
| `webhook_endpoints` | ORG_ADMIN full CRUD for own org |
| `billing_events` | User reads own; append-only (triggers block UPDATE/DELETE) |
| `attestations` | Public read; write restricted to authenticated users |

### Tenant Isolation

Multi-tenancy is enforced at the database level, not the application level:

- Every row that belongs to a tenant carries an `org_id` foreign key.
- RLS policies use `auth.uid()` to resolve the caller's identity and `org_id` to scope access.
- Helper functions (`is_org_admin_of()`, `get_user_org_ids()`) are `SECURITY DEFINER` to avoid circular RLS dependencies.
- Cross-tenant data access is architecturally impossible — the database will not return rows outside the caller's org scope, regardless of the query constructed.

### The Client-Side Processing Boundary

**Documents never leave the user's device.** This is Arkova's foundational privacy guarantee.

```
┌─────────────────────────────────────────────────────────┐
│  USER'S DEVICE (Browser)                                │
│                                                         │
│  Document  ──►  PDF.js / Tesseract.js  ──►  Raw OCR    │
│                 (Web Worker)                Text         │
│                                              │          │
│                                              ▼          │
│                                    PII Stripping        │
│                                    (SSN, DOB, names,    │
│                                     emails, phones)     │
│                                              │          │
│  SHA-256 Fingerprint  ◄──── Document ────────┤          │
│       (32 bytes)                             │          │
│            │                                 ▼          │
│            │                     PII-Stripped Metadata   │
│            │                     + Fingerprint           │
└────────────┼─────────────────────────┼──────────────────┘
             │                         │
     ────────┼─────────────────────────┼──── NETWORK BOUNDARY
             │                         │
             ▼                         ▼
    ┌─────────────┐          ┌─────────────────┐
    │  Supabase   │          │  Worker (AI)    │
    │  (anchor    │          │  (metadata      │
    │   record)   │          │   extraction    │
    │             │          │   only)         │
    └─────────────┘          └─────────────────┘
```

**Why this matters for partners and investors:**

- Arkova is **not a data processor** under GDPR for document content. We never receive it.
- There is no "raw mode" bypass. The `ENABLE_AI_EXTRACTION` feature flag gates the entire pipeline; it cannot be configured to send unstripped text.
- The `generateFingerprint()` function is architecturally prohibited from being imported in server-side code — this is enforced by import boundary checks.
- Client-side PII stripping uses regex-based removal of SSNs, student IDs, dates of birth, email addresses, phone numbers, and names before any data crosses the network boundary.

This design means Arkova avoids the regulatory complexity and liability of server-side document processing entirely. Partners integrating with Arkova do not need to assess Arkova as a document custodian in their vendor risk assessments.

### Audit Trail

All significant actions are logged to an **immutable, append-only** `audit_events` table:

- Database triggers reject all `UPDATE` and `DELETE` operations — even from `service_role`.
- Event categories: `AUTH`, `ANCHOR`, `PROFILE`, `ORG`, `ADMIN`, `SYSTEM`.
- PII fields (`actor_email`) are nullified at write time (migration 0061).
- Audit data supports SOC 2 evidence collection (evidence package documented).

### API Key Security

- API keys are hashed with **HMAC-SHA256** using a dedicated `API_KEY_HMAC_SECRET`. Raw keys are never stored after initial creation.
- Keys support scoped permissions: `verify`, `verify:batch`, `keys:manage`, `usage:read`.
- Key rotation does not require downtime — new keys can be provisioned before old keys are revoked.

### On-Chain Content Policy

Only 36 bytes are ever written to Bitcoin: `ARKV` (4 bytes) + SHA-256 hash (32 bytes). The following are **explicitly forbidden** from on-chain transactions: filenames, file sizes, MIME types, user IDs, org IDs, email addresses, and any PII.

---

## 3. Terminology & Compliance

### Strict Enterprise Terminology

Arkova maintains a strict terminology policy to ensure all user-facing language is appropriate for enterprise, legal, and regulatory audiences. The following terms are **banned from all user-visible strings**:

| Banned Term | Required Alternative | Rationale |
|-------------|---------------------|-----------|
| Wallet | Fee Account / Billing Account | Avoids confusion with custodial cryptocurrency wallets |
| Transaction | Network Receipt / Anchor Receipt | Prevents association with financial transactions |
| Hash | Fingerprint | Enterprise-friendly; conveys intent without technical jargon |
| Block | Network Confirmation | Avoids blockchain-specific terminology |
| Blockchain / Bitcoin | Anchoring Network / Production Network | Keeps messaging technology-neutral |
| Testnet / Mainnet | Test Environment / Production Network | Standard enterprise environment naming |
| Gas | Network Fee | Not applicable (OP_RETURN model), but reserved |
| UTXO / Broadcast | (internal only) | No user-visible equivalent needed |

This policy is **CI-enforced** via `npm run lint:copy`. All user-visible strings are centralized in `src/lib/copy.ts`. Internal code and documentation may use technical terms freely.

### Jurisdiction Metadata

Arkova supports **jurisdiction-aware credentials**. Every credential may optionally carry a jurisdiction tag (e.g., `US-MI`, `UK`, `EU`). Key design decisions:

- Jurisdiction is **informational metadata only** — it does not trigger different processing paths or legal interpretations.
- In API responses, `jurisdiction` is omitted entirely when null (never returned as `null` — this is a frozen schema contract).
- Jurisdiction tags enable downstream consumers (ATS systems, compliance tools) to apply their own jurisdiction-specific logic.

### Credential Types

Arkova supports a comprehensive taxonomy of credential types:

| Type | Examples |
|------|----------|
| `DIPLOMA` | University degrees, academic diplomas |
| `CERTIFICATE` | Professional certifications, course completions |
| `LICENSE` | Professional licenses, regulatory permits |
| `BADGE` | Digital badges, micro-credentials |
| `ATTESTATION` | Third-party attestation claims |
| `FINANCIAL` | Financial compliance documents |
| `LEGAL` | Legal agreements, contracts |
| `INSURANCE` | Insurance certificates, COIs |
| `SEC_FILING` | SEC regulatory filings |
| `PATENT` | Patent filings and grants |
| `REGULATION` | Regulatory documents |
| `PUBLICATION` | Academic publications |
| `OTHER` | General-purpose catch-all |

### Compliance Posture

| Requirement | Arkova's Approach |
|-------------|-------------------|
| **GDPR** | Non-custodial for documents. Fingerprints are one-way hashes; originals cannot be recovered. Account deletion (right to erasure) implemented with full cascade. |
| **SOC 2** | Evidence collection documented. Branch protection, RLS, audit trails, and key management provide CC6.1/CC6.3/CC7.2 controls. |
| **Data Retention** | Configurable retention policies. `cleanup_expired_data` RPC runs on schedule. Legal hold overrides prevent deletion when active. |
| **CCPA** | Account deletion cascade covers all personal data. No sale of personal information. |

---

## 4. AI Intelligence Suite

### Overview

Arkova's AI Intelligence Suite provides automated credential extraction, fraud detection, semantic search, and compliance analysis — all while respecting the client-side processing boundary. The AI operates exclusively on **PII-stripped metadata**, never on raw document content.

### Architecture

```
┌────────────────────────────────────┐
│  Client (Browser)                  │
│                                    │
│  OCR (PDF.js + Tesseract.js)       │
│         │                          │
│         ▼                          │
│  PII Stripping (regex-based)       │
│         │                          │
│         ▼                          │
│  Stripped Text + Fingerprint       │
└─────────┼──────────────────────────┘
          │  POST /api/v1/ai/extract
          ▼
┌────────────────────────────────────┐
│  Worker (Server)                   │
│                                    │
│  IAIProvider Interface             │
│    ├── GeminiProvider (primary)    │
│    ├── Cloudflare AI (fallback)    │
│    └── Replicate (QA only)        │
│         │                          │
│         ▼                          │
│  Structured Metadata Fields        │
│  + Confidence Score (0-1)          │
│  + Integrity Score (0-100)         │
└────────────────────────────────────┘
```

### Capabilities

| Capability | Description | Endpoint |
|------------|-------------|----------|
| **Metadata Extraction** | Extracts structured fields (issuer, recipient, dates, type) from PII-stripped OCR text using Gemini Flash. Returns confidence scores per field. | `POST /api/v1/ai/extract` |
| **Batch Extraction** | Process multiple credentials in a single request. Supports up to 100 items. | `POST /api/v1/ai/extract/batch` |
| **Semantic Search** | Natural language search across all credentials using pgvector embeddings (768-dim). | `GET /api/v1/ai/search` |
| **Fraud / Integrity Scoring** | Computes a 0-100 integrity score analyzing duplicate likelihood, metadata consistency, and issuer confidence. Scores below 60 are auto-flagged for human review. | `POST /api/v1/ai/integrity/compute` |
| **Visual Fraud Detection** | Image-based fraud analysis for credential documents. | `POST /api/v1/ai/fraud/visual` |
| **Human Review Queue** | Flagged credentials surface in an admin review queue with disposition workflow. | `GET /api/v1/ai/review` |
| **Extraction Feedback** | Closed-loop learning: human corrections feed back to improve future extraction accuracy. | `POST /api/v1/ai/feedback` |
| **RAG Query (Nessie)** | Retrieval-augmented generation against the full Arkova knowledge base (29,000+ public records, credentials, regulatory filings). Returns cited sources. | `POST /api/v1/nessie/query` |
| **Compliance Check** | Entity-level compliance risk scoring against regulatory records. | `POST /api/v1/compliance/check` |
| **Entity Verification** | Cross-reference entities against public records (EDGAR, Federal Register, DAPIP, OpenAlex). | `GET /api/v1/verify/entity` |

### Cost-Efficiency Model

Arkova's AI suite is designed for enterprise-scale cost efficiency:

| Operation | Cost | Model |
|-----------|------|-------|
| Metadata Extraction | 1 AI credit | Gemini 2.0 Flash |
| Semantic Search | 1 AI credit | text-embedding-004 |
| Fraud Analysis | 5 AI credits | Gemini 2.0 Flash |
| Embedding Generation | 1 AI credit | text-embedding-004 |
| RAG Query (Nessie) | Variable | Gemini 2.0 Flash + pgvector |

**Why Gemini Flash:** At approximately $0.075 per 1M input tokens, Gemini Flash provides extraction accuracy on par with larger models (F1=82.1% on our golden evaluation dataset of 2,050+ entries) at a fraction of the cost. The provider abstraction layer (`IAIProvider`) supports hot-swapping to OpenAI or Anthropic if model economics or accuracy shift.

### Feature Flags

All AI capabilities are gated by server-side feature flags:

| Flag | Gates | Default |
|------|-------|---------|
| `ENABLE_AI_EXTRACTION` | All extraction endpoints + client-side AI pipeline | `false` |
| `ENABLE_SEMANTIC_SEARCH` | pgvector search endpoints | `false` |
| `ENABLE_AI_FRAUD` | Fraud analysis pipeline | `false` |

### Public Data Pipeline

Arkova continuously ingests and indexes public records for entity verification and compliance checking:

| Source | Records | Update Frequency |
|--------|---------|-----------------|
| SEC EDGAR | Filings | Continuous |
| Federal Register | Regulatory actions | Continuous |
| DAPIP (Dept. of Education) | Institutional data | Batch (resumable) |
| OpenAlex | Academic publications | Every 30 minutes |
| **Total** | **29,000+** | Auto-growing via Cloud Scheduler |

All records are embedded (9,300+ embeddings) and indexed for sub-second semantic search.

---

## 5. Roadmap & Evolution

### Three-Phase Product Evolution

| Phase | Name | Status | Description |
|-------|------|--------|-------------|
| **Phase 1** | Credentialing MVP | **Live (94% complete)** | Issue, anchor, verify, and search credentials. Bitcoin anchoring (Signet). AI extraction. Verification API. Webhook delivery. Payments (Stripe). |
| **Phase 1.5** | Foundation | **In Progress** | Public records pipeline, x402 micropayments (USDC on Base L2), Nessie RAG intelligence, Python/TypeScript SDKs, multi-chain support (Bitcoin + Base L2). |
| **Phase 2** | Attestations | **Planned** | Third-party attestation claims (identity, employment, education, certification, compliance). Attestation lifecycle (create, verify, expire, revoke). Attestation anchoring to Bitcoin. |
| **Phase 3** | E-Signatures | **Planned** | Legally recognized electronic signatures layered on top of the anchoring infrastructure. |

### Detailed Milestone Roadmap

| Milestone | Target | Key Deliverables |
|-----------|--------|-----------------|
| Beta Launch (Signet) | **Complete** | 1,572+ SECURED anchors, 13 beta stories, 2,236 tests |
| Bitcoin Mainnet Window | Q2 2026 | Mainnet treasury funding, batch anchoring, production chain receipts |
| Base L2 Anchoring | Q2 2026 | Multi-chain support via Base (lower cost, faster confirmations) |
| Attestation API (v1) | Q2 2026 | 5 attestation types, revocation, expiry, CRUD API |
| x402 Micropayments | Q2 2026 | USDC on Base L2, pay-per-call API access, self-hosted facilitator |
| Python & TypeScript SDKs | Q2 2026 | Partner integration libraries with full API coverage |
| Golden Dataset 2,000+ | Q2 2026 | Comprehensive AI evaluation across all credential types |
| Nessie RAG v1 | Q2 2026 | Natural language queries against 30K+ records |
| CLE Verification | Q3 2026 | Continuing Legal Education credit verification |
| E-Signature Layer | Q4 2026 | Legally binding signatures anchored to Bitcoin |

### Infrastructure Metrics (Current)

| Metric | Value |
|--------|-------|
| Database Migrations | 121 |
| Test Suite | 2,433+ tests (1,024 frontend + 1,409 worker) |
| Stories Completed | 180 / 192 (94%) |
| Security Audit Findings Resolved | 24 / 24 (100%) |
| SECURED Anchors | 1,572+ |
| Public Records Indexed | 29,000+ |
| Vector Embeddings | 9,300+ |
| AI Eval F1 Score | 82.1% |

---

## 6. Developer Reference

### Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** | React 18 + TypeScript | Single-page application |
| **Styling** | Tailwind CSS + shadcn/ui | Component library and design system |
| **Icons** | Lucide React | Consistent icon set |
| **Bundler** | Vite | Development and production builds |
| **Routing** | react-router-dom v6 | Client-side routing with named routes |
| **Database** | Supabase (Postgres) | Managed Postgres with auth, realtime, and RLS |
| **Auth** | Supabase Auth | Email/password, Google OAuth (planned), MFA/TOTP |
| **Worker** | Node.js + Express | Webhooks, anchoring jobs, cron, AI processing |
| **Validation** | Zod | Runtime schema validation on all write paths |
| **Payments** | Stripe (SDK + webhooks) | Subscription billing (worker-only, never browser) |
| **Micropayments** | x402 Protocol (USDC on Base L2) | Pay-per-call API access |
| **Chain (Bitcoin)** | bitcoinjs-lib + Cloud HSM | OP_RETURN anchoring with HSM-backed signing |
| **Chain (Base L2)** | viem | EVM-based anchoring (calldata) |
| **AI (Primary)** | Gemini 2.0 Flash | Extraction, fraud, RAG |
| **AI (Fallback)** | Cloudflare Workers AI | Gated by `ENABLE_AI_FALLBACK` |
| **AI (QA Only)** | Replicate | Hard-blocked in production |
| **Vector Search** | pgvector (Postgres extension) | 768-dim embeddings for semantic search |
| **Testing** | Vitest + Playwright | Unit, integration, RLS, and E2E tests |
| **Formal Verification** | TLA PreCheck | State machine correctness proofs (anchor lifecycle) |
| **Observability** | Sentry | Error tracking with mandatory PII scrubbing |
| **Edge Compute** | Cloudflare Workers | MCP server, queue processing, AI fallback |
| **Ingress** | Cloudflare Tunnel | Zero Trust, no public ports exposed |
| **CI/CD** | GitHub Actions → Vercel (frontend) + Railway (worker) | Automated deploy on merge to main |

### Infrastructure Topology

```
┌──────────────────────────────────────────────────────────────┐
│  Internet                                                     │
│                                                               │
│  ┌───────────────┐    ┌───────────────┐    ┌──────────────┐ │
│  │  Vercel CDN   │    │  Cloudflare   │    │  Railway     │ │
│  │  (Frontend)   │    │  Tunnel       │    │  (Worker)    │ │
│  │  React SPA    │    │  Zero Trust   │    │  Express API │ │
│  └───────┬───────┘    └───────┬───────┘    └──────┬───────┘ │
│          │                    │                    │          │
│          ▼                    ▼                    ▼          │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Supabase (Managed Postgres)                         │    │
│  │  • Auth  • Realtime  • RLS  • pgvector              │    │
│  └──────────────────────────────────────────────────────┘    │
│          │                                    │              │
│          ▼                                    ▼              │
│  ┌───────────────┐                   ┌───────────────┐      │
│  │  Stripe       │                   │  Bitcoin /    │      │
│  │  (Payments)   │                   │  Base L2      │      │
│  └───────────────┘                   └───────────────┘      │
└──────────────────────────────────────────────────────────────┘
```

### Webhook Reliability Standards

Partners configuring outbound webhooks can expect the following reliability guarantees:

| Standard | Specification |
|----------|--------------|
| **Delivery Protocol** | HTTPS only (enforced by database CHECK constraint) |
| **Signature** | HMAC-SHA256 on full payload body. Signature in `X-Arkova-Signature` header. |
| **Timestamp** | ISO 8601 UTC in `X-Arkova-Timestamp` header |
| **Event Type** | `X-Arkova-Event` header (e.g., `anchor.secured`) |
| **Retry Policy** | 5 attempts with exponential backoff: immediate → 1m → 5m → 30m → 2h |
| **Circuit Breaker** | Consecutive failures trip the circuit. Endpoint disabled. Probe after cooldown. |
| **Dead Letter Queue** | After all retries exhausted, events retained for 30 days. Manual replay available. |
| **Timeout** | 30-second delivery timeout |
| **Rate Limit** | 100 deliveries/minute per organization |
| **SSRF Protection** | Private IP ranges blocked, DNS resolution validated, metadata endpoints blocked |
| **Idempotency** | `idempotency_key` on each delivery prevents duplicate processing |

**Supported Webhook Events:**

| Event | Trigger |
|-------|---------|
| `anchor.created` | New credential anchor created |
| `anchor.secured` | Anchor confirmed on Bitcoin network |
| `anchor.revoked` | Credential revoked |
| `anchor.verified` | Verification lookup performed |
| `attestation.created` | New attestation claim created |
| `attestation.revoked` | Attestation revoked |

### Authentication Methods

| Method | Use Case | Header |
|--------|----------|--------|
| **API Key (Bearer)** | Verification API, batch operations | `Authorization: Bearer ak_live_...` |
| **API Key (Header)** | Alternative API key delivery | `X-API-Key: ak_live_...` |
| **Supabase JWT** | Key management, AI endpoints | `Authorization: Bearer eyJ...` |
| **x402 Payment** | Pay-per-call (no subscription) | HTTP 402 → USDC payment → retry with proof |

### Rate Limiting

| Scope | Limit | Response |
|-------|-------|----------|
| Anonymous (public verification) | 100 req/min per IP | HTTP 429 + `Retry-After` |
| API Key holders | 1,000 req/min per key | HTTP 429 + `Retry-After` |
| Batch endpoints | 10 req/min per API key | HTTP 429 + `Retry-After` |

Rate limit headers are included on every response.

---

## 7. API Reference

### Base URL

```
https://{worker-host}/api/v1
```

Interactive documentation (Swagger UI) is available at `/api/docs`. The OpenAPI 3.0 spec is downloadable at `/api/docs/spec.json`.

### Authentication

All authenticated endpoints accept API keys via two methods:

```bash
# Bearer token
curl -H "Authorization: Bearer ak_live_your_key_here" https://api.arkova.io/api/v1/verify/ARK-2026-001

# Header
curl -H "X-API-Key: ak_live_your_key_here" https://api.arkova.io/api/v1/verify/ARK-2026-001
```

### Verification Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/verify/{publicId}` | Optional (API key for higher rate limits) | Verify a single credential by public ID. Returns the frozen verification schema. |
| `POST` | `/verify/batch` | Required (API key) | Batch verify up to 100 credentials. Synchronous for ≤20, async (returns `job_id`) for >20. |
| `GET` | `/verify/{publicId}/proof` | Optional | Download cryptographic proof package for a credential. |
| `GET` | `/verify/entity` | Required (API key or x402) | Cross-reference entity against public records (EDGAR, Federal Register, DAPIP, OpenAlex). |
| `GET` | `/verify/search` | Required (API key) | Agentic semantic search returning frozen verification schema. Designed for AI agents, ATS, and background check integrations. |
| `GET` | `/jobs/{jobId}` | Required (API key) | Poll async batch job status. |
| `GET` | `/usage` | Required (API key) | Current month API usage across all org keys. |

### Verification Response Schema (Frozen)

The verification response schema is **frozen** — fields cannot be removed or renamed after publication. Only additive nullable fields may be added.

```json
{
  "verified": true,
  "status": "ACTIVE",
  "issuer_name": "University of Michigan",
  "recipient_identifier": "sha256:ab3f...",
  "credential_type": "DIPLOMA",
  "issued_date": "2026-01-15T00:00:00Z",
  "expiry_date": null,
  "anchor_timestamp": "2026-03-10T08:00:00Z",
  "bitcoin_block": 204567,
  "network_receipt_id": "b8e381df09ca404e...",
  "merkle_proof_hash": null,
  "record_uri": "https://app.arkova.io/verify/ARK-2026-001",
  "jurisdiction": "US-MI"
}
```

**Status values:** `ACTIVE`, `REVOKED`, `SUPERSEDED`, `EXPIRED`, `PENDING`

**Key contract:** `jurisdiction` is **omitted** when null — it is never returned as `null`.

### Anchoring Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/anchor` | Required (API key or x402) | Submit a credential fingerprint for Bitcoin anchoring. Idempotent — returns 200 if fingerprint already exists. |

**Request:**
```json
{
  "fingerprint": "a1b2c3d4e5f6...64-char-hex",
  "label": "Bachelor of Science in Computer Science",
  "credential_type": "DIPLOMA",
  "metadata": {
    "issuer": "University of Michigan",
    "issued_date": "2026-01-15"
  }
}
```

### Attestation Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/attestations` | Required (JWT or API key) | Create an attestation claim for a credential. |
| `GET` | `/attestations` | Public | List attestations with cursor-based pagination. Filter by `anchor_public_id`. |
| `GET` | `/attestations/{publicId}` | Public | Retrieve a single attestation. Checks expiry. |
| `PATCH` | `/attestations/{publicId}/revoke` | Required (owner) | Revoke an attestation with optional reason. |

**Attestation Types:** `identity`, `employment`, `education`, `certification`, `compliance`

**Attestation Lifecycle:**
```
Created (active) ──► Expired (auto, via expires_at)
       │
       └──────────► Revoked (manual, with reason)
```

### Compliance Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/compliance/check` | Required (API key or x402) | Compliance risk scoring against regulatory records. Returns risk score + findings. |
| `GET` | `/regulatory/lookup` | Required (API key or x402) | Search public regulatory records (EDGAR, Federal Register, DAPIP, OpenAlex). |
| `GET` | `/cle/verify` | Required (API key or x402) | Verify Continuing Legal Education credits by attorney name, bar number, or jurisdiction. |
| `GET` | `/cle/credits` | Required (API key or x402) | Look up CLE credit balance. |
| `POST` | `/cle/submit` | Required (API key) | Submit a CLE course completion. |
| `GET` | `/cle/requirements` | Public | Retrieve CLE requirements by jurisdiction. |

### AI Intelligence Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/ai/extract` | Required (JWT) | Extract structured metadata from PII-stripped text. 1 AI credit. |
| `POST` | `/ai/extract/batch` | Required (JWT) | Batch extraction for multiple credentials. |
| `POST` | `/ai/embed` | Required (JWT) | Generate 768-dim pgvector embedding. 1 AI credit. |
| `POST` | `/ai/embed/batch` | Required (JWT) | Batch embedding generation. |
| `GET` | `/ai/search` | Required (JWT) | Natural language semantic search. 1 AI credit. |
| `POST` | `/ai/integrity/compute` | Required (JWT) | Compute fraud/integrity score (0-100). Auto-flags below 60. |
| `GET` | `/ai/integrity/{anchorId}` | Required (JWT) | Retrieve existing integrity score. |
| `POST` | `/ai/fraud/visual` | Required (JWT) | Visual fraud detection on credential images. |
| `GET` | `/ai/review` | Required (JWT, ORG_ADMIN) | List flagged items in review queue. |
| `GET` | `/ai/review/stats` | Required (JWT, ORG_ADMIN) | Review queue statistics. |
| `PATCH` | `/ai/review/{itemId}` | Required (JWT, ORG_ADMIN) | Disposition a review queue item. |
| `POST` | `/ai/feedback` | Required (JWT) | Submit extraction corrections for learning loop. |
| `GET` | `/ai/feedback/accuracy` | Required (JWT) | Extraction accuracy metrics. |
| `GET` | `/ai/feedback/analysis` | Required (JWT) | Feedback analysis and trends. |
| `GET` | `/ai/usage` | Required (JWT) | AI credit balance and usage history. |
| `POST` | `/ai/reports` | Required (JWT) | Generate AI-powered compliance report. |
| `GET` | `/ai/reports` | Required (JWT) | List generated reports. |
| `GET` | `/ai/reports/{reportId}` | Required (JWT) | Retrieve a specific report. |

### RAG Query Endpoint

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/nessie/query` | Required (JWT + x402) | Natural language question against the Arkova knowledge base. Returns answer with cited sources. |

**Request:**
```json
{
  "query": "What SEC filings mention Company X in the last 6 months?",
  "max_sources": 5
}
```

**Response:**
```json
{
  "answer": "Company X appears in 3 SEC filings...",
  "sources": [
    { "title": "10-K Annual Report", "url": "https://...", "relevance": 0.94 },
    { "title": "8-K Current Report", "url": "https://...", "relevance": 0.87 }
  ],
  "tokens_used": 1240
}
```

### Webhook Management Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/webhooks/test` | Required (API key) | Send a synthetic test event to verify endpoint configuration. |
| `GET` | `/webhooks/deliveries` | Required (API key) | View recent delivery attempts. Filter by `endpoint_id`. |

### Key Management Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/keys` | Required (Supabase JWT) | Create a new API key. Raw key returned once. |
| `GET` | `/keys` | Required (Supabase JWT) | List API keys (masked). |
| `PATCH` | `/keys/{keyId}` | Required (Supabase JWT) | Update key name or scopes. |
| `DELETE` | `/keys/{keyId}` | Required (Supabase JWT) | Revoke an API key. |

### Utility Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/health` | None | Health check. Always available regardless of feature flags. |
| `GET` | `/docs` | None | Interactive Swagger UI documentation. |
| `GET` | `/docs/spec.json` | None | Downloadable OpenAPI 3.0 specification. |

### Error Response Format

All errors follow a consistent schema:

```json
{
  "error": "not_found",
  "message": "Credential with public ID ARK-2026-999 not found"
}
```

| HTTP Status | Meaning |
|-------------|---------|
| 400 | Invalid request parameters |
| 401 | Authentication required or invalid |
| 402 | Payment required (x402 micropayment or insufficient credits) |
| 403 | Insufficient permissions |
| 404 | Resource not found |
| 409 | Conflict (e.g., already revoked) |
| 429 | Rate limit exceeded (check `Retry-After` header) |
| 503 | Feature not enabled (feature flag is off) |

---

## 8. Shared Responsibility Matrix

### Partner Integration Responsibilities

| Responsibility | Arkova | Partner |
|---------------|--------|---------|
| **Credential Anchoring** | Manages Bitcoin/Base L2 transactions, fee accounts, and chain confirmation. | Submits fingerprints and metadata via API. |
| **Document Processing** | Provides client-side SDKs for fingerprinting and OCR. | Runs fingerprinting in their own client or server (SHA-256). |
| **Document Storage** | **Does not store documents.** | Stores and manages original documents. |
| **PII Management** | Strips PII client-side before any server transmission. | Ensures PII is not embedded in metadata sent to API. |
| **API Key Security** | Issues keys, enforces HMAC hashing, supports scoped permissions. | Stores keys securely. Rotates keys on schedule. Never exposes keys in client-side code. |
| **Webhook Verification** | Signs all outbound webhooks with HMAC-SHA256. | Verifies `X-Arkova-Signature` on receipt. Rejects unsigned payloads. |
| **Webhook Endpoint Availability** | Retries with exponential backoff (5 attempts). Dead letter queue for failures. | Maintains HTTPS endpoint availability. Responds within 30 seconds. Returns 2xx on success. |
| **Rate Limit Compliance** | Enforces limits and returns `Retry-After` headers. | Implements backoff. Caches verification results where appropriate. |
| **Data Retention** | Enforces configurable retention policies. Supports legal holds. | Defines retention requirements. Communicates legal hold needs. |
| **Credential Status** | Provides real-time status (ACTIVE, REVOKED, EXPIRED, PENDING). | Queries status before relying on credential validity. |
| **Attestation Claims** | Stores, verifies, and manages attestation lifecycle. | Creates attestation claims with accurate data. Revokes when appropriate. |
| **Compliance Checks** | Provides regulatory record lookups and risk scoring. | Interprets risk scores in context of own compliance requirements. |
| **AI Extraction Accuracy** | Targets and maintains F1 > 80% across credential types. | Submits feedback corrections to improve model accuracy. |
| **Uptime & SLA** | Worker service with health monitoring and auto-scaling. | Implements graceful degradation if Arkova is unavailable. |
| **Schema Versioning** | Frozen v1 schema. 12-month deprecation for breaking changes. | Builds against versioned schema. Handles additive fields gracefully. |
| **Jurisdiction Metadata** | Stores and returns jurisdiction tags as informational metadata. | Applies own jurisdiction-specific logic to returned metadata. |

### Investor Infrastructure Summary

| Dimension | Detail |
|-----------|--------|
| **Hosting** | Vercel (frontend CDN), Railway (worker compute), Supabase (managed Postgres) |
| **Security** | Cloudflare Zero Trust ingress, RLS on every table, HMAC-SHA256 API keys, cloud HSM signing, SOC 2 evidence collection |
| **Scalability** | Stateless worker (horizontal scaling), Postgres connection pooling, CDN-cached frontend, async batch processing for large jobs |
| **Reliability** | Circuit breakers, dead letter queues, exponential backoff, idempotent webhooks, advisory-lock-free processing |
| **AI Infrastructure** | Provider-agnostic (Gemini/OpenAI/Anthropic), credit-based cost controls, feature-flagged rollout, 2,050+ entry golden evaluation dataset |
| **Compliance Readiness** | GDPR (non-custodial), SOC 2 (evidence documented), immutable audit trail, configurable data retention, legal hold support |
| **Chain Strategy** | Bitcoin (immutability) + Base L2 (cost efficiency). Non-custodial. Technology-neutral user experience. |

---

_This document is confidential and intended for Arkova partners, investors, and integration teams. For questions, contact support@arkova.ai._
_Generated from the Arkova Technical Directive v2026-03-23 | 121 migrations | 2,433+ tests | 192 stories (94% complete)_
