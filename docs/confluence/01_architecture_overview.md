# Architecture Overview

_Last updated: 2026-03-17_

## Purpose

Arkova is a document anchoring system that creates cryptographic fingerprints of documents and secures them on-chain for tamper-evident timestamping. Users never upload documents — only SHA-256 fingerprints are stored and anchored.

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Frontend | React 18 + TypeScript | Vite bundler |
| Styling | Tailwind CSS | Custom Arkova brand tokens in `src/index.css` |
| Components | shadcn/ui + Lucide React | Do not edit `src/components/ui/` directly |
| Backend | Supabase (PostgreSQL + Auth) | RLS mandatory on all tables |
| Validation | Zod | All write paths validated before DB call |
| Routing | react-router-dom v6 | Named routes in `src/lib/routes.ts` |
| Worker | Node.js + Express | `services/worker/` — webhooks, anchoring jobs, cron |
| Payments | Stripe (SDK + webhooks) | Worker-only — never in browser |
| Chain | bitcoinjs-lib + AWS KMS (target) | SignetChainClient + MockChainClient |
| Edge Compute | Cloudflare Workers + wrangler | Batch queue, R2 reports, AI fallback, crawler |
| AI | Gemini (primary), @cloudflare/ai (fallback) | IAIProvider abstraction, mock for tests |
| Observability | Sentry (@sentry/node + @sentry/react) | PII scrubbing mandatory |
| Ingress | Cloudflare Tunnel (cloudflared) | Zero Trust, no public ports |
| Testing | Vitest + Playwright | `npm test`, `npm run test:rls`, `npm run test:e2e` |

## Core Principles

### 1. Documents Never Leave the Device (Constitution Article 1)

Arkova does NOT store document content — not on-chain, not in the database, not anywhere server-side. Only the SHA-256 fingerprint is stored. Fingerprint computation (`generateFingerprint` in `src/lib/fileHasher.ts`) runs exclusively in the browser via the Web Crypto API.

This guarantees:
- **Privacy**: Document contents never leave the user's device
- **FERPA compliance**: No student records stored server-side
- **Scalability**: No large blob storage required

### 2. Tenant Isolation via RLS

All data access is enforced at the database level through Row Level Security (RLS). The application code does not implement access control — PostgreSQL policies handle it entirely. Every table has `FORCE ROW LEVEL SECURITY` enabled.

### 3. UTC Timestamps

All server-side timestamps are stored as `timestamptz` and treated as UTC. Bitcoin timestamps are displayed as "Network Observed Time" — never "Confirmed At" or "Finalized".

### 4. Non-Custodial Model

Arkova does NOT hold user cryptocurrency, process deposits/withdrawals, or manage user wallets. All on-chain fees are paid from a corporate fee account managed by Arkova.

## Architecture Diagram

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   React App     │────▶│  Supabase       │────▶│  Worker Service │
│   (Vite)        │     │  (Auth + DB)    │     │  (Express)      │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │                       │
        │ SHA-256 in browser    │ pgvector              ├──▶ Bitcoin Chain
        │ OCR + PII strip       │ embeddings            ├──▶ Stripe API
        │ (Constitution 1.6)    │                       ├──▶ Gemini AI
        ▼                       ▼                       │
   fingerprint +         ┌─────────────────┐           ▼
   PII-stripped          │  Edge Workers   │   ┌─────────────────┐
   metadata only         │  (Cloudflare)   │   │  Sentry         │
                         ├─────────────────┤   └─────────────────┘
                         │  Batch Queue    │
                         │  R2 Reports     │
                         │  AI Fallback    │
                         │  MCP Server     │
                         │  Crawler        │
                         └─────────────────┘
```

## Directory Structure

```
arkova/
├── src/
│   ├── App.tsx                    # React Router (BrowserRouter + Routes + guards)
│   ├── main.tsx                   # Entry point
│   ├── index.css                  # Brand tokens (CSS custom properties)
│   ├── components/
│   │   ├── ui/                    # shadcn/ui primitives (do not edit)
│   │   ├── anchor/                # SecureDocumentDialog, FileUpload, AssetDetailView
│   │   ├── auth/                  # LoginForm, SignUpForm, AuthGuard, RouteGuard
│   │   ├── billing/               # BillingOverview, PricingCard
│   │   ├── credentials/           # CredentialTemplatesManager
│   │   ├── dashboard/             # StatCard, EmptyState
│   │   ├── layout/                # AppShell, Header, Sidebar, AuthLayout
│   │   ├── onboarding/            # RoleSelector, OrgOnboardingForm, ManualReviewGate
│   │   ├── organization/          # IssueCredentialForm, MembersTable, RevokeDialog
│   │   ├── public/                # PublicVerifyPage, ProofDownload
│   │   ├── upload/                # BulkUploadWizard, CSVUploadWizard
│   │   ├── verification/          # PublicVerification (5-section result display)
│   │   └── webhooks/              # WebhookSettings
│   ├── hooks/                     # useAuth, useAnchors, useProfile, useOnboarding, etc.
│   ├── lib/
│   │   ├── copy.ts                # All UI strings (enforced by CI)
│   │   ├── validators.ts          # Zod schemas for all writes
│   │   ├── fileHasher.ts          # Client-side SHA-256 (Web Crypto API)
│   │   ├── routes.ts              # Named route constants
│   │   ├── switchboard.ts         # Feature flags
│   │   ├── supabase.ts            # Supabase client
│   │   ├── proofPackage.ts        # Proof package schema + generator
│   │   └── generateAuditReport.ts # PDF certificate generation (jsPDF)
│   ├── pages/                     # Page components (thin wrappers)
│   └── types/
│       └── database.types.ts      # Auto-generated from Supabase — never edit
├── services/
│   └── worker/
│       └── src/
│           ├── index.ts           # Express server + cron + graceful shutdown
│           ├── config.ts          # Environment config
│           ├── ai/                # IAIProvider, GeminiProvider, cost-tracker, feedback
│           ├── api/v1/            # Verification API, AI endpoints, OpenAPI docs
│           ├── chain/             # ChainClient, SignetChainClient, MockChainClient
│           ├── jobs/              # Anchor processing, webhook dispatch, credit expiry
│           ├── stripe/            # Stripe SDK + webhook handlers
│           ├── webhooks/          # Outbound webhook delivery engine
│           └── utils/             # DB client, logger, rate limiter, rpc helpers
├── services/
│   └── edge/
│       └── src/
│           ├── index.ts           # Cloudflare Worker entry point
│           ├── env.ts             # Typed CF environment bindings
│           ├── batch-queue.ts     # Batch processing queue consumer
│           ├── report-generator.ts # R2 report storage + signed URLs
│           ├── cloudflare-crawler.ts # University directory ingestion
│           ├── ai-fallback.ts     # Workers AI fallback provider
│           ├── mcp-server.ts      # MCP server (Streamable HTTP + OAuth)
│           └── mcp-tools.ts       # verify_credential + search_credentials tools
├── supabase/
│   ├── config.toml                # Supabase local config
│   ├── migrations/                # 72 SQL migrations (0001–0072, 0033 skipped, 0068 split into 0068a/0068b)
│   └── seed.sql                   # Demo data (UMich Registrar, Midwest Medical, individual)
├── tests/
│   └── rls/                       # RLS integration test helpers
├── e2e/                           # Playwright E2E specs
├── scripts/
│   └── check-copy-terms.ts        # Copy lint (banned term enforcement)
├── docs/
│   └── confluence/                # This documentation folder
├── CLAUDE.md                      # Engineering directive (rules + story status)
└── HANDOFF.md                     # Living state (decisions, blockers, handoffs)
```

## Security Model

See [03_security_rls.md](./03_security_rls.md) for detailed security documentation.

Key principles:
1. **RLS Mandatory**: All tables have Row Level Security enabled with `FORCE ROW LEVEL SECURITY`
2. **Least Privilege**: Public grants revoked; access via policies only
3. **Role Immutability**: User roles cannot be changed after initial assignment (enforced by trigger)
4. **Audit Trail**: All sensitive actions logged to append-only `audit_events` table
5. **Privileged Field Protection**: Trigger blocks direct client updates to `org_id`, `is_verified`, `subscription_tier`, and other admin fields on `profiles`

## Database Schema

See [02_data_model.md](./02_data_model.md) for the complete data model.

### Table Inventory (32+ tables across 72 migrations)

| Table | Migration | Purpose |
|-------|-----------|---------|
| `organizations` | 0002 | Tenant organizations |
| `profiles` | 0003 | User profiles (linked to `auth.users`) |
| `anchors` | 0004 | Document fingerprint records |
| `audit_events` | 0006 | Immutable audit log (PII-scrubbed via trigger) |
| `plans` | 0016 | Subscription plan definitions |
| `subscriptions` | 0016 | User subscription state |
| `entitlements` | 0016 | Feature entitlements per subscription |
| `billing_events` | 0016 | Payment event log |
| `anchoring_jobs` | 0017 | Anchor processing queue |
| `anchor_proofs` | 0017 | On-chain proof data |
| `webhook_endpoints` | 0018 | Org webhook configuration |
| `webhook_delivery_logs` | 0018 | Webhook delivery audit trail |
| `reports` | 0019 | Report requests and metadata |
| `report_artifacts` | 0019 | Generated report files |
| `switchboard_flags` | 0021 | Feature flags |
| `switchboard_flag_history` | 0021 | Flag change audit trail |
| `invitations` | 0022 | Org member invitations |
| `memberships` | 0022 | Org membership records |
| `credential_templates` | 0040 | Reusable credential templates |
| `verification_events` | 0042 | Public verification analytics |
| `anchor_chain_index` | 0050 | On-chain transaction index |
| `institution_ground_truth` | 0051 | Crawler-ingested institution records |
| `credits` | 0053 | Anchor quota credits |
| `anchor_recipients` | 0056 | Credential recipient associations |
| `api_keys` | 0057 | Verification API key management |
| `batch_verification_jobs` | 0058 | Batch verification job queue |
| `ai_credits` | 0059 | AI credit allocations per org/user |
| `ai_usage_events` | 0059 | AI credit consumption log |
| `credentials_embeddings` | 0060 | pgvector embeddings for semantic search |
| `extraction_feedback` | 0064 | AI extraction feedback loop |
| `ai_review_queue` | 0064 | Admin review queue for flagged credentials |
| `ai_reports` | 0064 | AI-generated report tracking |

## P8 AI Intelligence Architecture

_Added 2026-03-17 (AUDIT-24)_

### AI Processing Pipeline

```
Document (browser)                    Worker (server-side)
───────────────────────         ─────────────────────────────────
1. Client-side OCR              5. Gemini extraction (PII-stripped)
   (PDF.js + Tesseract.js)      6. Embedding generation (text-embedding-004)
2. PII stripping                7. Integrity scoring (5 dimensions)
   (SSN, email, phone, DOB)     8. Duplicate detection (cosine similarity)
3. Fingerprint (SHA-256)        9. Review queue (flagged items)
4. Upload metadata only        10. Report generation (R2 storage)
```

### Credit System

| Tier | Monthly Credits | AI Features |
|------|----------------|-------------|
| Free | 50 | Extraction, search |
| Individual (Pro) | 500 | + Batch processing |
| Professional | 5,000 | + Reports, priority |
| Enterprise | Custom | + Dedicated support |

Credits tracked in `ai_credits` table. Each extraction = 1 credit, each embedding = 1 credit.
Monthly allocation via `allocate_monthly_credits()` RPC (cron: 1st of month).

### AI Provider Abstraction

`IAIProvider` interface (`services/worker/src/ai/types.ts`) with:
- `GeminiProvider` — primary (circuit breaker: 5 failures / 60s, retry 3x)
- `CloudflareFallbackProvider` — edge compute fallback
- `MockAIProvider` — tests (AI_PROVIDER=mock)

Factory: `createAIProvider()` selects based on `AI_PROVIDER` env var.

### Review Queue States

```
PENDING → INVESTIGATING → ESCALATED → APPROVED
    ↓                          ↓
  APPROVED                  DISMISSED
    ↓
  DISMISSED
```

### Edge Worker Architecture (Cloudflare Workers)

| Route | Handler | Purpose |
|-------|---------|---------|
| `/batch` | batch-queue.ts | Process queued batch AI jobs |
| `/reports` | report-generator.ts | Generate + store reports in R2 |
| `/crawl` | cloudflare-crawler.ts | Ingest institution directories |
| `/ai` | ai-fallback.ts | Workers AI fallback extraction |
| `/mcp` | mcp-server.ts | MCP server (Streamable HTTP) |

## Local Development

```bash
# Start Supabase locally
supabase start

# Reset database (runs migrations + seed)
supabase db reset

# Generate TypeScript types
npm run gen:types

# Run tests
npm test

# Run RLS tests
npm run test:rls

# Run copy lint (banned term enforcement)
npm run lint:copy
```

## Formal Verification

_Added 2026-03-17_

The Bitcoin anchor state machine has been formally verified using TLA+ model checking (TLA PreCheck). The specification lives in `machines/bitcoinAnchor.machine.ts`.

### Verified State Machine

```
PENDING → PENDING_CHAIN → SECURED → REVOKED
             ↓ (fail)         ↑
             PENDING ─────────┘ (retry)

Legal hold: toggled on SECURED or REVOKED anchors (blocks revocation)
```

### Proven Invariants (6/6)

| # | Invariant | What It Proves |
|---|-----------|----------------|
| INV-1 | `securedRequiresChainTx` | SECURED always has `chain_tx_id` — no orphaned anchors |
| INV-2 | `fingerprintImmutableAfterPending` | Fingerprint locked once processing begins |
| INV-3 | `revokedIsTerminal` | No status transitions out of REVOKED |
| INV-4 | `metadataImmutableAfterSecured` | Metadata frozen after SECURED |
| INV-5 | `onlyWorkerSecures` | Only worker (service_role) can set SECURED — client bypass impossible |
| INV-6 | `legalHoldPreventsSecuredToRevoked` | Legal hold blocks revocation transition |

### Proof Certificate

- **States explored:** 49 distinct (127 total)
- **Transitions:** 126 edges across 2 concurrent anchors
- **Graph equivalence:** TLA+ spec and TypeScript interpreter produce identical state graphs
- **Certificate:** `machines/.generated-machines/BitcoinAnchor/pr/BitcoinAnchor.pr.certificate.json`

### How To Re-verify

```bash
cd machines && npx tla-precheck check bitcoinAnchor   # verify invariants
cd machines && npx tla-precheck build bitcoinAnchor   # regenerate adapter
```

When modifying the anchor lifecycle (new statuses, new transitions), update `machines/bitcoinAnchor.machine.ts` first and run `check` before writing any code.

### Finding: credential_type Not Immutable After SECURED

During verification research, we discovered that `credential_type` can be updated even after an anchor is SECURED. The `protect_anchor_status_transition()` trigger does NOT guard this column, unlike `metadata` (which has `prevent_metadata_edit_after_secured()`). This is tracked as a backlog item.

## Related Documentation

- [00_index.md](./00_index.md) - Documentation reading guide
- [02_data_model.md](./02_data_model.md) - Database schema details
- [03_security_rls.md](./03_security_rls.md) - RLS policies and security
- [04_audit_events.md](./04_audit_events.md) - Audit logging
- [05_retention_legal_hold.md](./05_retention_legal_hold.md) - Data retention
- [06_on_chain_policy.md](./06_on_chain_policy.md) - On-chain content policy
- [07_seed_clickthrough.md](./07_seed_clickthrough.md) - Seed data guide
- [08_payments_entitlements.md](./08_payments_entitlements.md) - Payment system
- [09_webhooks.md](./09_webhooks.md) - Webhook implementation
- [10_anchoring_worker.md](./10_anchoring_worker.md) - Worker service
- [11_proof_packages.md](./11_proof_packages.md) - Proof packages
- [12_identity_access.md](./12_identity_access.md) - Identity and access management
- [13_switchboard.md](./13_switchboard.md) - Feature flags
