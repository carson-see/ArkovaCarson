# ARKOVA — Claude Code Engineering Directive

> **Version:** 2026-03-16 (Sprint 3 PRs merged — security hardening, testnet4, AI extraction — 15/19 AI stories, migration 0063)
> **Repo:** ArkovaCarson | **Branch:** main | **Deploy:** arkova-carson.vercel.app
> **Companion files:** `HANDOFF.md` (living state — Phase 3/4 tracking), `ARCHIVE_memory.md` (historical context)

Claude Code reads this file automatically before every task. It contains the rules, the repo map, and the current story status. If something conflicts with HANDOFF.md, this file wins on rules; HANDOFF.md wins on current state.

---

## 0. MANDATORY METHODOLOGY — APPLIES BEFORE ALL OTHER RULES

> **These five mandates override everything below. No exceptions. No shortcuts.**

### ARCHITECT MANDATE
You must use your `sequential-thinking` MCP tool to brainstorm and validate architecture before writing any code. Break complex problems into manageable steps. Do not jump to implementation — think first, plan the approach, identify risks, then execute.

### TDD MANDATE
All code must follow Test-Driven Development (Red-Green-Refactor):
1. **Red:** Write a failing test that defines the desired behavior.
2. **Green:** Write the minimum code to make the test pass.
3. **Refactor:** Clean up the code while keeping tests green.
No production code without a corresponding test written first.

### SECURITY MANDATE
You must manually check for PII leakage, command injection, and vulnerable dependencies before finalizing any file. Act as your own Code Reviewer. Specifically:
- Scan for hardcoded secrets, API keys, PII in logs or error messages.
- Check for command injection, SQL injection, XSS, and path traversal.
- Verify dependencies are not known-vulnerable (`npm audit`).
- Confirm RLS policies cover new tables/columns.
- This is in addition to (not a replacement for) Constitution Section 1.4.

### TOOLING MANDATE
Always use the Playwright MCP tool to verify frontend UI changes. After any component, page, or styling change:
- Navigate to the affected page.
- Take a snapshot or screenshot to confirm the change renders correctly.
- Verify no visual regressions on adjacent components.

### UAT MANDATE
Every prompt that involves UI/frontend work (component changes, page updates, styling, routing, layout) **must conclude with a UAT verification step** before finalizing. This means:
1. **Start the dev server** (via `preview_start` or equivalent).
2. **Navigate to every affected page** at both desktop (1280px) and mobile (375px) viewports.
3. **Take screenshots** or snapshots to confirm changes render correctly.
4. **Check for regressions** on adjacent pages that share modified components (e.g., if AppShell changes, verify Dashboard, Records, and Org pages).
5. **Log any new bugs found** during UAT in `docs/bugs/` with full reproduction steps.
6. If authentication is required and unavailable in the dev environment, verify structure via accessibility snapshots and document the limitation.

UAT is not optional. A task is not complete until UAT screenshots confirm the changes work at both viewport sizes.

### BACKLOG MANDATE
All backlog items — stories, bugs, security findings, operational tasks, GEO items — **must exist in a single source of truth**: `docs/BACKLOG.md`. This document is prioritized and re-prioritized each session. No backlog item should exist only in a story doc, bug report, or session log — it must also appear in BACKLOG.md. When work is completed, update BACKLOG.md before closing the session. Every backlog item must also have corresponding story documentation in `docs/stories/` (grouped by priority level).

---

## 0.1. READ FIRST — EVERY SESSION

```
1. CLAUDE.md          ← You are here. Rules, Mandates, Constitution, story status.
2. HANDOFF.md         ← Living state. Phase 3/4 tracking, blockers, decisions.
3. docs/BACKLOG.md    ← **SINGLE SOURCE OF TRUTH** for all open work (stories, bugs, security, ops).
4. ARCHIVE_memory.md  ← Historical context from prior phases.
5. docs/confluence/01_architecture_overview.md  ← If it exists.
6. The relevant agents.md in any folder you are about to edit.
7. The story card from the Technical Backlog for the story you are implementing.
```

If a folder contains an `agents.md`, read it before touching anything. If you learn something important during your work, update that folder's `agents.md` AND the "Current State" section of HANDOFF.md.

---

## 1. THE CONSTITUTION — RULES THAT CANNOT BE BROKEN

These rules apply to every task. If a story conflicts with any rule below, **the rule wins**.

### 1.1 Tech Stack (Locked)

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
| Ingress | Cloudflare Tunnel (`cloudflared`) | Zero Trust ingress to worker container. No public ports. |
| Edge Compute | Cloudflare Workers + `wrangler` (dev dep) | Peripheral tasks only (Queues, R2, AI fallback). NOT for core worker logic. |
| Observability | Sentry (`@sentry/react`, `@sentry/node`, `@sentry/profiling-node`) | Error tracking + performance. PII scrubbing mandatory. |
| AI (extended) | `@cloudflare/ai` (fallback), `replicate` (QA only), `@modelcontextprotocol/sdk` (future) | See scoping rules below. Primary AI remains Vertex AI ADK (P8). |

**Hard constraints:**
- Never use Next.js API routes for long-running jobs
- New AI libraries require explicit architecture review before introduction
- No server-side document processing — ever (see 1.6)
- Cloudflare Workers handle ONLY peripheral edge tasks (queues, reports, AI fallback). Core anchor processing, Stripe webhooks, and cron jobs stay in `services/worker/` Express container.
- `@cloudflare/ai` is fallback-only — never the primary extraction provider. Gated by `ENABLE_AI_FALLBACK` flag (default: `false`).
- `replicate` is QA/synthetic-data-only — hard-blocked in production (`NODE_ENV=production` + `ENABLE_SYNTHETIC_DATA!=true`).
- `@modelcontextprotocol/sdk` is installed for future use. No MCP server code until P4.5 Verification API is complete.
- Sentry must have PII scrubbing enabled. No user emails, document fingerprints, or API keys in Sentry events (Constitution 1.4 + 1.6).

### 1.2 Schema-First (Non-Negotiable)

- Define DB schema + enums + constraints + RLS **before** building any UI that depends on them
- Once a table exists, **never use mock data or useState arrays** to represent that table's data — query Supabase
- Every schema change requires: migration file + rollback comment + regenerated `database.types.ts` + updated seed data + updated Confluence page
- Never modify an existing migration file — write a new compensating migration

### 1.3 Terminology (UI Copy Only)

**Banned terms — never appear in any user-visible string:**

`Wallet` · `Gas` · `Hash` · `Block` · `Transaction` · `Crypto` · `Blockchain` · `Bitcoin` · `Testnet` · `Mainnet` · `UTXO` · `Broadcast`

| Banned | Use Instead |
|--------|-------------|
| Wallet | Fee Account / Billing Account |
| Transaction | Network Receipt / Anchor Receipt |
| Hash | Fingerprint |
| Block | (omit or "Network Record") |
| Testnet / Mainnet | Test Environment / Production Network |
| Broadcast | Publish Anchor |

All UI copy sourced from `src/lib/copy.ts`. CI fails if banned terms appear: `npm run lint:copy`.

Internal code/DB may use technical names (e.g., `file_fingerprint_sha256`, `chain_tx_id`).

### 1.4 Security (Mandatory)

- RLS on every table. `FORCE ROW LEVEL SECURITY` on all tables.
- No direct writes to privileged fields from client code.
- SECURITY DEFINER functions must include `SET search_path = public`.
- Never expose `supabase.auth.admin` or service role key to the browser.
- Never hardcode secrets, API keys, or private keys anywhere.
- Treasury/signing keys: server-side only, loaded from env vars, never logged.
- Stripe webhook handlers must call `stripe.webhooks.constructEvent()` — no exceptions.
- API keys must be hashed with HMAC-SHA256 using `API_KEY_HMAC_SECRET`. Raw keys never persisted after creation.
- API key lifecycle events (create, revoke) must be logged to `audit_events`.
- Setting `anchor.status = 'SECURED'` is worker-only via service_role — never from client code.

### 1.5 Timestamps & Evidence

- All server-side timestamps: Postgres `timestamptz`, treated as UTC.
- Bitcoin timestamps displayed as **"Network Observed Time"** — never "Confirmed At" or "Finalized".
- Proof packages must state: what is measured, what is asserted, what is NOT asserted.
- Jurisdiction tags are informational metadata — Arkova does not verify jurisdiction correctness.

### 1.6 Client-Side Processing Boundary

- **Documents never leave the user's device.** This is the foundational privacy guarantee.
- File fingerprinting (`generateFingerprint`) runs in the browser only — never server-side.
- `generateFingerprint` must never be imported or called in `services/worker/`.
- The Gemini AI Integration Specification in Drive describes server-side document processing — it violates this rule and is NOT authoritative. Do not reference it.

#### Constitution 4A — AI Metadata Exception

The foundational guarantee (documents never leave the device) remains absolute for **document bytes and raw OCR text**. A narrow exception exists for **PII-stripped structured metadata**:

1. **Client-side OCR** (PDF.js + Tesseract.js in a Web Worker) extracts raw text from the document on the user's device.
2. **Client-side PII stripping** removes all personally identifiable information (SSN, student IDs, DOB, email addresses, phone numbers, names matched against recipient fields) before anything leaves the browser.
3. **PII-stripped structured metadata** (credential type, issuer, dates, field labels — never raw OCR text, never document bytes) plus the document fingerprint may be sent to the server.
4. **Server-side AI** (Gemini Flash or equivalent via `IAIProvider`) processes only the PII-stripped metadata. The server never receives, stores, or processes the original document, its raw OCR output, or any PII.

**What MUST stay client-only:**
- Document bytes (PDF, image, etc.)
- Raw OCR text output
- Any text containing PII (pre-stripping)
- File fingerprinting (`generateFingerprint`)

**What MAY flow to server (post-stripping only):**
- Credential type classification
- Issuer name, issue/expiry dates
- Field labels and anonymized structure
- Document fingerprint (SHA-256 hash)

This exception is gated behind the `ENABLE_AI_EXTRACTION` feature flag (default: `false`). PII stripping is mandatory and cannot be disabled — there is no "raw mode" bypass.

### 1.7 Testing

- RLS tests must use `src/tests/rls/helpers.ts` `withUser()` / `withAuth()` — no ad-hoc auth mocking.
- Tests must not call real Stripe or Bitcoin APIs — use `IPaymentProvider` and `IAnchorPublisher` interfaces.
- Every task must keep the repo green: `typecheck`, `lint`, `test`, `lint:copy` all pass.
- Coverage enforced via `@vitest/coverage-v8`. Per-file 80% thresholds on critical paths (see `vitest.config.ts` and `services/worker/vitest.config.ts`). CI runs `npm run test:coverage`.

### E2E Testing Rules
_Added 2026-03-10 10:45 PM EST_

- E2E tests live in `e2e/` and use Playwright (`@playwright/test`).
- All E2E specs must use shared fixtures from `e2e/fixtures/` — no inline login flows.
- E2E test data: use seed users for reads, timestamped unique names for writes, cleanup after.
- Never hardcode Supabase URLs or keys in spec files — use env vars via fixtures.
- E2E tests must not depend on other spec files' side effects — each spec is isolated.
- New user-facing flows require a corresponding E2E spec before the story is marked COMPLETE.
- Run `npm run test:e2e` locally before pushing changes that affect routing, auth, or core flows.
- Load/stress tests live in `tests/load/` and run via `npm run test:load` — not part of CI gate.
- E2E fixtures: `e2e/fixtures/auth.ts` (authenticated pages), `e2e/fixtures/supabase.ts` (service client + seed users + test data helpers), `e2e/fixtures/index.ts` (barrel export).
- Seed user constants (`SEED_USERS`) are defined in `e2e/fixtures/supabase.ts` — never duplicate credentials inline.

### 1.8 API Versioning (Phase 1.5+)

- Verification API response schema is frozen once published. No field removals, type changes, or semantic changes without a new version prefix.
- Breaking changes require: v2+ URL prefix, 12-month deprecation notice, documented migration guide.
- Additive changes (new nullable fields) allowed without versioning.
- Frozen schema defined as `VerificationResult` OpenAPI component — single source of truth.

### 1.9 Feature Flags

- `ENABLE_VERIFICATION_API` controls all `/api/v1/*` endpoints. When `false`, returns HTTP 503.
- `ENABLE_PROD_NETWORK_ANCHORING` gates real Bitcoin chain calls. Both checked via `switchboard_flags` table.
- `/api/health` always available regardless of flag state.

### 1.10 Rate Limiting (Phase 1.5+)

- Anonymous: 100 req/min per IP.
- API key holders: 1,000 req/min per key.
- Batch endpoints: 10 req/min per API key.
- Rate limit headers on every response. HTTP 429 with `Retry-After` on excess.

---

## 2. HOW TO RECEIVE A TASK

**Format A — Story ID:**
> "Implement P7-TS-05"

1. Read the story card in the Technical Backlog (acceptance criteria, dependencies, tech notes, DoD)
2. Check the Audit Note — it tells you what exists and what the gap is
3. **Check CLAUDE.md Section 8** — story status may be more current than the backlog PDF
4. Verify all dependencies are met
5. **State your plan** before writing code: what you will change, what you will NOT touch, what tests you will run

**Format B — Direct instruction:**
> "Fix SecureDocumentDialog to use real Supabase insert"

1. Map to the closest story ID in Section 8
2. Proceed as Format A

**Format C — Brand/UI task:**
> "Apply Arkova brand tokens"

See Section 5.

---

## 3. TASK EXECUTION RULES

### Before writing code
- [ ] Read the story card fully
- [ ] Read the story doc in `docs/stories/` for your story's priority group
- [ ] Confirm dependencies are met (check Section 8)
- [ ] Read `agents.md` in any folder you will touch
- [ ] State your plan (files to change, files to leave alone, tests to run)

### While writing code
- [ ] One story at a time — do not fix unrelated things
- [ ] If you find a bug outside scope, log it in MEMORY.md Bug Tracker (full template) and stop
- [ ] New tables: migration + rollback comment + RLS + `database.types.ts` + seed update
- [ ] New hooks: follow `useAuth.ts` / `useAnchors.ts` pattern
- [ ] New components: `src/components/<domain>/` with barrel export in `index.ts`
- [ ] Validators: `src/lib/validators.ts` — not inline
- [ ] UI strings: `src/lib/copy.ts` — not hardcoded in JSX

### After writing code
```bash
npx tsc --noEmit          # zero type errors
npm run lint              # zero lint errors
npm run test:coverage     # all tests pass + coverage thresholds met
npm run lint:copy         # no banned terms
npm run gen:types         # if schema changed
```

Update `docs/confluence/` page if schema/security/API changed. Update the story doc in `docs/stories/` if story status changed (e.g., PARTIAL → COMPLETE). Update `agents.md` in modified folders. Update MEMORY.md "Session Handoff Notes" section.

- [ ] If you changed a user-facing flow: E2E spec exists and passes (`npm run test:e2e`)
- [ ] **UAT verification complete** (per UAT Mandate): Playwright screenshots at desktop + mobile confirm changes render correctly. Any new bugs logged in `docs/bugs/`.

### Bug Documentation (Mandatory)

Every bug found during development must be documented. Where it goes depends on severity:

- **Production blockers** → CLAUDE.md Section 8 Critical Blockers table (CRIT-N format)
- **All other bugs** → MEMORY.md Bug Tracker section

**Required fields for every bug (no exceptions):**
1. **Steps to reproduce** — numbered, specific, reproducible by someone unfamiliar with the code
2. **Expected vs actual behavior** — what should happen and what does happen
3. **Root cause** — if known at time of logging, update later when diagnosed
4. **Actions taken** — every action attempted to fix, with dates
5. **Resolution** — fix description + commit reference, or "OPEN"
6. **Regression test** — test file/name that prevents recurrence, or "None yet"

If a bug is found and fixed in the same session, still log it — the documentation prevents future regressions and builds institutional knowledge.

### Definition of Done
- All acceptance criteria met
- Unit tests written and passing
- `typecheck` + `lint` + `test` + `lint:copy` all green
- Seed data click-through still works
- Confluence docs updated if applicable
- No regressions
- **UAT verified** — Playwright screenshots at desktop (1280px) and mobile (375px) confirm UI changes render correctly

---

## 4. FILE PLACEMENT MAP

```
CLAUDE.md                                    ← This file (rules + status)
MEMORY.md                                    ← Living state (decisions, blockers, handoffs)
src/
  App.tsx                                    ← React Router (BrowserRouter + Routes + guards)
  main.tsx                                   ← Entry point
  index.css                                  ← Brand tokens (CSS custom properties)
  components/
    ui/                                      ← shadcn/ui primitives (do not edit)
    anchor/                                  ← SecureDocumentDialog, FileUpload, AssetDetailView, ShareSheet
    auth/                                    ← LoginForm, SignUpForm, AuthGuard, RouteGuard
    billing/                                 ← BillingOverview, PricingCard
    credentials/                             ← CredentialTemplatesManager, CredentialRenderer, MetadataFieldRenderer
    dashboard/                               ← StatCard, EmptyState
    embed/                                   ← VerificationWidget + EmbedVerifyPage (routed at /embed/verify/:publicId)
    layout/                                  ← AppShell, Header, Sidebar, AuthLayout, Breadcrumbs
    onboarding/                              ← RoleSelector, OrgOnboardingForm, ManualReviewGate, EmailConfirmation, GettingStartedChecklist
    organization/                            ← IssueCredentialForm, MembersTable, RevokeDialog, OrgRegistryTable
    public/                                  ← PublicVerifyPage, ProofDownload
    records/                                 ← RecordsList
    reports/                                 ← ReportsList
    upload/                                  ← BulkUploadWizard, CSVUploadWizard, CsvUploader
    vault/                                   ← VaultDashboard
    verification/                            ← PublicVerification (5-section result display), RevocationDetails, VerifierProofDownload
    verify/                                  ← VerificationForm
    webhooks/                                ← WebhookSettings
    search/                                  ← SearchForm, IssuerCard, CredentialCard
  hooks/                                     ← useAuth, useAnchors, useProfile, useOnboarding, useMyCredentials, useCredentialTemplate, useTheme, etc.
  lib/
    copy.ts                                  ← All UI strings (enforced by CI)
    validators.ts                            ← Zod schemas for all writes
    fileHasher.ts                            ← Client-side SHA-256 (Web Crypto API)
    routes.ts                                ← Named route constants
    switchboard.ts                           ← Feature flags
    supabase.ts                              ← Supabase client
    proofPackage.ts                          ← Proof package schema + generator
    generateAuditReport.ts                   ← PDF certificate generation (jsPDF)
    csvExport.ts / csvParser.ts              ← CSV utilities
    auditLog.ts                              ← Client-side audit event logging
    logVerificationEvent.ts                  ← Fire-and-forget verification event logging
    workerClient.ts                          ← Shared fetch wrapper for frontend → worker API calls
  pages/                                     ← Page components (thin wrappers around domain components)
  types/database.types.ts                    ← Auto-generated from Supabase — never edit manually
  tests/rls/                                 ← RLS integration test helpers
services/worker/
  src/
    index.ts                                 ← Express server + cron + graceful shutdown
    config.ts                                ← Environment config
    chain/types.ts                           ← ChainClient + ChainIndexLookup interfaces, IndexEntry, request/response types
    chain/client.ts                          ← Async factory (initChainClient/getInitializedChainClient) + SupabaseChainIndexLookup
    chain/signet.ts                          ← BitcoinChainClient (renamed from SignetChainClient, alias kept). Supports signet/testnet/mainnet via provider abstractions.
    chain/mock.ts                            ← In-memory mock for tests and development
    chain/signing-provider.ts                ← WifSigningProvider (ECPair, signet/testnet) + KmsSigningProvider (AWS KMS, mainnet)
    chain/fee-estimator.ts                   ← StaticFeeEstimator (fixed rate) + MempoolFeeEstimator (live API)
    chain/utxo-provider.ts                   ← RpcUtxoProvider (Bitcoin Core RPC) + MempoolUtxoProvider (Mempool.space REST) + factory
    chain/wallet.ts                          ← Treasury wallet utilities (keypair generation, address derivation, WIF validation)
    jobs/anchor.ts                           ← Process pending anchors
    jobs/report.ts                           ← Report generation job
    jobs/webhook.ts                          ← Webhook dispatch job (stub)
    stripe/client.ts                         ← Stripe SDK + webhook signature verification
    stripe/handlers.ts                       ← Webhook event handlers
    stripe/mock.ts                           ← Mock Stripe for tests
    webhooks/delivery.ts                     ← Outbound webhook delivery engine
    ai/types.ts                              ← IAIProvider interface + shared AI types
    ai/factory.ts                            ← Provider factory (AI_PROVIDER env routing)
    ai/gemini.ts                             ← GeminiProvider (circuit breaker, retry, @google/generative-ai)
    ai/cloudflare-fallback.ts                ← CF Workers AI fallback (Nemotron)
    ai/cost-tracker.ts                       ← AI credit tracking + usage events
    ai/embeddings.ts                         ← Embedding generation pipeline (pgvector)
    ai/replicate.ts                          ← Replicate provider (QA/synthetic only)
    ai/schemas.ts                            ← Zod schemas for AI request/response validation
    ai/mock.ts                               ← Mock AI provider for tests
    ai/prompts/                              ← Prompt templates for extraction, classification
    api/verify-anchor.ts                     ← Public anchor verification by fingerprint
    api/v1/router.ts                         ← Verification API v1 route dispatcher
    api/v1/verify.ts                         ← GET /api/v1/verify/:publicId
    api/v1/batch.ts                          ← POST /api/v1/verify/batch
    api/v1/keys.ts                           ← API key CRUD (POST/GET/PATCH/DELETE)
    api/v1/usage.ts                          ← GET /api/v1/usage
    api/v1/jobs.ts                           ← GET /api/v1/jobs/:jobId
    api/v1/docs.ts                           ← OpenAPI 3.0 spec + Swagger UI at /api/docs
    api/v1/ai-extract.ts                     ← POST /api/v1/ai/extract
    api/v1/ai-search.ts                      ← Semantic search endpoint
    api/v1/ai-usage.ts                       ← GET /api/v1/ai/usage
    api/v1/ai-embed.ts                       ← Embedding generation endpoint
    api/v1/ai-verify-search.ts               ← Agentic verification search
    utils/                                   ← DB client, logger, rate limiter, correlation ID, sentry
services/edge/                               ← Cloudflare Worker scripts (ADR-002)
  wrangler.toml                              ← Edge worker config (bindings, routes)
  tsconfig.json                              ← Edge-specific TypeScript config
  src/
    index.ts                                 ← Edge worker entry point (route dispatcher)
    env.ts                                   ← Typed Cloudflare Worker environment bindings
    report-generator.ts                      ← PDF report generation worker (R2 storage)
    report-logic.ts                          ← Report content generation + R2 key builder
    batch-queue.ts                           ← Queue consumer for batch anchors
    batch-queue-logic.ts                     ← Throttled batch processing logic
    ai-fallback.ts                           ← CloudflareAIProvider (Workers AI)
    cloudflare-crawler.ts                    ← University directory ingestion (P8-S7)
    crawler-logic.ts                         ← HTML parsing + ground truth records
    mcp-server.ts                            ← Remote MCP server (P8-S19, Streamable HTTP)
    mcp-tools.ts                             ← MCP tool definitions (verify + search)
wrangler.toml                                ← Root config (R2 bucket, queue, AI bindings)
supabase/
  migrations/                                ← 56 files (0001–0056, 0033 skipped)
  seed.sql                                   ← Demo data
  config.toml                                ← Local Supabase config
docs/confluence/                             ← Architecture, data model, security, audit, etc.
docs/stories/                                ← Story documentation (one file per priority group)
docs/bugs/                                   ← Bug log (CRIT-1 through CRIT-N)
e2e/                                         ← Playwright E2E specs
tests/rls/                                   ← RLS integration tests
scripts/check-copy-terms.ts                  ← Copy lint (banned term enforcement)
.github/workflows/ci.yml                     ← CI pipeline
```

---

## 5. BRAND APPLICATION — "Nordic Vault" Design System (PR #42)

### Brand Colors

| Name | Hex | HSL | Usage |
|------|-----|-----|-------|
| Steel Blue | `#82b8d0` | 197 42% 66% | Primary / buttons / links |
| Charcoal | `#303433` | 156 4% 19% | Sidebar background / foreground |
| Ice Blue | `#dbeaf1` | 199 44% 90% | Secondary / light backgrounds |

### Typography (Locked)

| Token | Family | Source | Usage |
|-------|--------|--------|-------|
| `font-sans` | **DM Sans** (300–700) | Google Fonts, `index.html` | Headings, body text, UI labels |
| `font-mono` | **JetBrains Mono** (400, 500) | Google Fonts, `index.html` | Fingerprints, IDs, code blocks |

**Banned fonts:** Inter, Roboto, Arial, Space Grotesk, system-ui default stack. Never revert to these.

### CSS Custom Properties

The `:root` and `.dark` blocks in `src/index.css` define all theme tokens. The Arkova palette is already applied (Steel Blue as primary, Charcoal as sidebar). See `tailwind.config.ts` for the `arkova.*` color scale. Extended vars: `--glow-primary`, `--glow-success`, `--surface-elevated`.

### Atmospheric CSS Classes (defined in `src/index.css`)

| Class | Effect |
|-------|--------|
| `.bg-mesh-gradient` | Layered radial gradients for atmospheric content backgrounds |
| `.bg-dot-pattern` | Subtle dot grid pattern overlay (24px spacing) |
| `.glass-card` | Frosted glass (backdrop-filter blur 16px + transparency) |
| `.glass-header` | Glassmorphism header (blur 12px + saturate 1.5) |
| `.gradient-border` | Gradient border via CSS mask technique |
| `.glow-primary` / `.glow-success` | Colored glow box-shadows |
| `.nav-glow` | Active sidebar nav item glow bar (3px left) |
| `.sidebar-gradient` | Dark gradient for sidebar background |
| `.shimmer` | Animated loading state shimmer gradient |
| `.animate-in-view` | Staggered reveal-up animation (0.5s cubic-bezier) |
| `.animate-float` / `.animate-float-delayed` / `.animate-float-slow` | Floating decoration keyframes (6–8s) |
| `.stagger-1` through `.stagger-8` | Animation-delay utilities (60ms intervals) |

### Tailwind Shadows (defined in `tailwind.config.ts`)

| Token | Usage |
|-------|-------|
| `shadow-glow-sm/md/lg` | Primary-colored glow shadows (increasing intensity) |
| `shadow-card-hover` | Elevated hover state for cards |
| `shadow-card-rest` | Subtle rest state for cards |

### Brand Rules for New Components

When creating ANY new frontend component, follow these rules:

1. **Cards:** Use `shadow-card-rest` at rest, `shadow-card-hover` on hover with `hover:-translate-y-0.5`
2. **Page entry:** Use `animate-in-view` with `stagger-N` for staggered reveal animations
3. **Loading:** Use `shimmer` class for loading skeletons (NOT `Skeleton` component)
4. **Icon containers:** `rounded-xl` with gradient backgrounds (`bg-gradient-to-br from-primary/15 to-primary/5`)
5. **Labels:** Uppercase with tracking: `text-xs font-medium uppercase tracking-wide`
6. **Emphasis buttons:** `shadow-glow-sm hover:shadow-glow-md`
7. **Code/IDs:** `font-mono` (JetBrains Mono) for fingerprints, IDs, code
8. **Never revert** to Inter, Roboto, or system fonts
9. **Sidebar:** `sidebar-gradient` class, `nav-glow` on active items
10. **Header:** `glass-header` (backdrop blur), slim `h-14`
11. **Auth pages:** `bg-mesh-gradient` + `bg-dot-pattern` overlay + floating orbs + `gradient-border` card
12. **Status badges:** SECURED=green, PENDING=amber, REVOKED=gray, EXPIRED=gray
13. **Fingerprint display:** `font-mono text-xs bg-muted rounded px-2 py-1`
14. **Logo:** White wordmark + light blue bear on dark backgrounds; full-color on white

### Frontend Aesthetics Anti-Patterns (AVOID)

- Overused font families (Inter, Roboto, Arial, system fonts, Space Grotesk)
- Cliché color schemes (purple gradients on white backgrounds)
- Predictable layouts and cookie-cutter component patterns
- Flat solid-color backgrounds (use mesh gradients, dot patterns, atmospheric depth)
- Generic loading states (use shimmer, not basic skeleton rectangles)
- Missing motion (every page should have orchestrated entry animations)

---

## 6. DOCUMENTATION UPDATE PROCEDURE

Any task that changes schema, security posture, or API contracts must update docs in the same commit.

| What Changed | Update This Page |
|-------------|-----------------|
| Schema change | `docs/confluence/02_data_model.md` |
| RLS policy | `docs/confluence/03_security_rls.md` |
| Audit events | `docs/confluence/04_audit_events.md` |
| Legal hold / retention | `docs/confluence/05_retention_legal_hold.md` |
| Bitcoin / chain | `docs/confluence/06_on_chain_policy.md` |
| Seed data | `docs/confluence/07_seed_clickthrough.md` |
| Billing (P7+) | `docs/confluence/08_payments_entitlements.md` |
| Webhooks (P7+) | `docs/confluence/09_webhooks.md` |
| Worker (P7+) | `docs/confluence/10_anchoring_worker.md` |
| Proof packages (P7+) | `docs/confluence/11_proof_packages.md` |
| Verification API (P4.5+) | `docs/confluence/12_verification_api.md` |
| Identity / access | `docs/confluence/12_identity_access.md` |
| Feature flags | `docs/confluence/13_switchboard.md` |
| Story status change | `docs/stories/` (the group doc for that story's priority) |

If a page doesn't exist yet, create it using this template:

```markdown
# [Page Title]
_Last updated: [date] | Story: [story ID]_

## Overview
[1-2 sentence summary]

## Current State
[What is implemented]

## Schema / Contract
[Tables, columns, functions, or API contracts]

## Security Notes
[RLS, SECURITY DEFINER, access control]

## Change Log
| Date | Story | Change |
|------|-------|--------|
```

### Document Standards

All docs live in `docs/confluence/` and are numbered 00–15 (18 files total). The index (`00_index.md`) lists all documents with descriptions and a suggested reading order.

Every doc must include:
- `_Last updated: [date] | Story: [story ID]_` line below the title
- Schema docs reference specific migration numbers (e.g., "migration 0016")
- Implementation status tables distinguish **Complete / Partial / Not Started**
- Change log at the bottom tracking audit history
- Cross-references use relative markdown links (e.g., `[02_data_model.md](./02_data_model.md)`)

When a doc describes something that is partially implemented or a known gap exists, document it explicitly — never imply that something works if it doesn't.

### Story Documentation (`docs/stories/`)

Story docs live in `docs/stories/` and are grouped by priority level (one file per group). The index (`00_stories_index.md`) lists all 163 stories with status, group doc reference, and bug cross-references.

| File | Group | Stories |
|------|-------|---------|
| `01_p1_bedrock.md` | P1 Bedrock | 6 |
| `02_p2_identity.md` | P2 Identity & Access | 5 |
| `03_p3_vault.md` | P3 Vault & Dashboard | 3 |
| `04_p4e1_anchor_engine.md` | P4-E1 Anchor Engine | 3 |
| `05_p4e2_credential_metadata.md` | P4-E2 Credential Metadata | 3 |
| `06_p5_org_admin.md` | P5 Org Admin | 6 |
| `07_p6_verification.md` | P6 Verification | 6 |
| `08_p7_go_live.md` | P7 Go-Live | 13 |
| `09_p45_verification_api.md` | P4.5 Verification API | 13 |
| `10_deferred_hardening.md` | DH Deferred Hardening | 12 |
| `11_mvp_launch_gaps.md` | MVP Launch Gaps | 27 |
| `12_p8_ai_intelligence.md` | P8 AI Intelligence | 19 |
| `13_infrastructure_edge.md` | INFRA Edge & Ingress | 8 |
| `14_uat_sprints.md` | UAT Bug Fix Sprints (5+6) | 17 |
| `14_user_flow_gaps.md` | UF User Flow Gaps | 10 |
| `15_geo_seo.md` | GEO & SEO Optimization | 12 |

When a story's status changes:
1. Update the story's section in its group doc (Status field, Completion Gaps, Remaining Work)
2. Update the group overview counts at the top of the group doc
3. Update `00_stories_index.md` Completion Summary table
4. Update CLAUDE.md Section 8 story status table

PARTIAL stories must include "Completion Gaps" and "Remaining Work" subsections. When a PARTIAL story becomes COMPLETE, remove those subsections and update all status fields.

### agents.md Updates

After modifying any folder, update or create `agents.md`:

```markdown
# agents.md — [folder name]
_Last updated: [date]_

## What This Folder Contains
## Recent Changes
## Do / Don't Rules
## Dependencies
```

---

## 7. MIGRATION PROCEDURE

```bash
# 1. Create migration (next sequential number)
#    supabase/migrations/NNNN_descriptive_name.sql
#    Include at bottom: -- ROLLBACK: [compensating SQL]

# 2. Apply locally
npx supabase db push

# 3. Regenerate types
npx supabase gen types typescript --local > src/types/database.types.ts

# 4. Update seed data
#    Edit supabase/seed.sql

# 5. Verify click-through
npx supabase db reset

# 6. Update docs/confluence/02_data_model.md
```

**Never modify an existing migration file.** Write a new compensating migration instead.

**Current migration inventory:** 63 files, versions 0001–0065 (0033 skipped). Last: `0065_account_deletion.sql`. Migrations 0001–0058 applied to production. Migrations 0059–0065 pending production apply.

---

## 8. STORY STATUS — MARCH 2026

> **Source of truth.** When this conflicts with the Technical Backlog PDF audit notes, trust this section.

| Priority | Complete | Partial | Not Started | % Done |
|----------|----------|---------|-------------|--------|
| P1 Bedrock | 6/6 | 0 | 0 | 100% |
| P2 Identity | 5/5 | 0 | 0 | 100% |
| P3 Vault | 3/3 | 0 | 0 | 100% |
| P4-E1 Anchor Engine | 3/3 | 0 | 0 | 100% |
| P4-E2 Credential Metadata | 3/3 | 0 | 0 | 100% |
| P5 Org Admin | 6/6 | 0 | 0 | 100% |
| P6 Verification | 6/6 | 0 | 0 | 100% |
| P7 Go-Live | 11/13 | 0 | 2/13 | 85% | <!-- P7-TS-04 and P7-TS-06 not enumerated (no individual scope) --> |
| P4.5 Verification API | 13/13 | 0 | 0 | 100% |
| DH Deferred Hardening | 12/12 | 0 | 0 | 100% |
| MVP Launch Gaps | 25/27 | 0 | 2/27 | 93% |
| P8 AI Intelligence | 15/19 | 0 | 4/19 | 79% |
| INFRA Edge & Ingress | 7/8 | 1/8 | 0/8 | 88% |
| UAT Bug Fix Sprints | 17/17 | 0 | 0 | 100% |
| UF User Flow Gaps | 10/10 | 0 | 0 | 100% |
| GEO & SEO | 4/12 | 3/12 | 5/12 | 33% |
| **Total** | **146/163** | **4/163** | **13/163** | **~90%** |

### Critical Blockers (resolve before production)

| ID | Issue | Severity | Detail |
|----|-------|----------|--------|
| ~~CRIT-1~~ | ~~`SecureDocumentDialog` fakes anchor creation~~ | ~~HIGH~~ | ~~RESOLVED 2026-03-10. Real Supabase insert replacing setTimeout simulation. Commit a38b485.~~ |
| ~~CRIT-2~~ | ~~Bitcoin chain client — code complete, operational items only~~ | ~~**OPS-ONLY**~~ | ~~**CODE COMPLETE.** All code written and tested. BitcoinChainClient with provider abstractions, SupabaseChainIndexLookup, async factory, wallet utilities, CLI scripts. 604 worker tests. Signet E2E broadcast verified (TX `b8e381df`). KMS operational docs in `14_kms_operations.md`. **Remaining operational items only:** AWS KMS key provisioning, mainnet treasury funding. See `docs/confluence/15_operational_runbook.md`.~~ |
| ~~CRIT-3~~ | ~~Stripe checkout~~ | ~~HIGH~~ | ~~RESOLVED 2026-03-14 (PR #43). Plan change/downgrade via Billing Portal. All entitlement enforcement complete.~~ |
| ~~CRIT-4~~ | ~~Onboarding routes are placeholders~~ | ~~MEDIUM~~ | ~~RESOLVED 2026-03-10. OnboardingRolePage, OnboardingOrgPage, ReviewPendingPage wired into App.tsx. Commit a38b485.~~ |
| ~~CRIT-5~~ | ~~Proof export JSON download is no-op~~ | ~~MEDIUM~~ | ~~RESOLVED 2026-03-10. onDownloadProofJson wired in RecordDetailPage + AssetDetailView. Commit a38b485.~~ |
| ~~CRIT-6~~ | ~~`CSVUploadWizard` uses simulated processing~~ | ~~MEDIUM~~ | ~~RESOLVED 2026-03-10. Connected to csvParser + useBulkAnchors hook. Commit a38b485.~~ |
| ~~CRIT-7~~ | ~~Browser tab says "Ralph"~~ | ~~LOW~~ | ~~RESOLVED 2026-03-10. `package.json` name → `arkova`, `index.html` title → `Arkova`.~~ |

### P1 Bedrock — 6/6 COMPLETE

All foundational work done: schema (enums, tables, RLS), validators (Zod), audit trail (append-only + triggers), validation-on-insert wired in ConfirmAnchorModal.

### P2 Identity — 5/5 COMPLETE

- P2-TS-03: BrowserRouter + Routes in App.tsx with named routes
- P2-TS-04: AuthGuard + RouteGuard wired into router
- P2-TS-05: useProfile hook with DB persistence
- P2-TS-06: useOrganization hook, OrgSettingsPage wired
- P2-TS-0X: LoginForm, SignUpForm, ProfilePage, SettingsPage all routed

### P3 Vault — 3/3 COMPLETE

- P3-TS-01: DashboardPage + VaultDashboard use `useAnchors()` — real Supabase queries, no mock data
- P3-TS-02: `is_public_profile` migration + RLS + toggle persisted to DB via `updateProfile()`
- P3-TS-03: Sidebar uses `<Link>` with active route highlighting

### P4-E1 Anchor Engine — 3/3 COMPLETE

- P4-TS-01: ConfirmAnchorModal — upload, fingerprint, validateAnchorCreate(), insert, audit log
- P4-TS-02: AssetDetailView — record fields, QR code, lifecycle timeline
- P4-TS-03: RecordDetailPage at `/records/:id` with `useAnchor()` real query

### P4-E2 Credential Metadata — 3/3 COMPLETE

> **Note:** The Technical Backlog PDF says these are "NOT STARTED". It is wrong. All three are implemented.

- P4-TS-04: `credential_type` enum + column (migration 0029)
- P4-TS-05: `metadata` JSONB + editability trigger (migration 0030)
- P4-TS-06: `parent_anchor_id` + `version_number` lineage (migrations 0031-0032)

### P5 Org Admin — 6/6 COMPLETE

- P5-TS-01: OrgRegistryTable — status filter, search, date range, bulk select, CSV export
- P5-TS-02: RevokeDialog — reason field, persisted to DB (migration 0036)
- P5-TS-03: MembersTable wired to `useOrgMembers()` real Supabase query
- P5-TS-05: `public_id` auto-generated on INSERT (migration 0037)
- P5-TS-06: BulkUploadWizard supports `credential_type` + `metadata` columns in CSV
- P5-TS-07: `credential_templates` migration (0040), CRUD hook, CredentialTemplatesManager, routed at `/settings/credential-templates`

### P6 Verification — 6/6 COMPLETE

- P6-TS-01: ✅ `get_public_anchor` RPC rebuilt (migration 0044). PublicVerification.tsx renders 5 sections. Wired to `/verify/:publicId`.
- P6-TS-02: ✅ QRCodeSVG in AssetDetailView for SECURED anchors. Links to `/verify/{publicId}`.
- P6-TS-03: ✅ COMPLETE — `VerificationWidget.tsx` routed at `/embed/verify/:publicId` via `EmbedVerifyPage`. Barrel export in `src/components/embed/index.ts`. Logs verification events with `method='embed'`. 10 tests (PR #57).
- P6-TS-04: ✅ COMPLETE — `AnchorLifecycleTimeline` wired into PublicVerification.tsx Section 5. `mapToLifecycleData()` maps snake_case RPC fields to camelCase props. Shows on both detail and public pages.
- P6-TS-05: ✅ `generateAuditReport.ts` (jsPDF, 201 lines). Called from RecordDetailPage.
- P6-TS-06: ✅ `verification_events` table (migration 0042), SECURITY DEFINER RPC (migration 0045), wired into PublicVerification.tsx.

### P7 Go-Live — 11/13 COMPLETE, 2/13 NOT STARTED

- P7-TS-01: ✅ Billing schema (migration 0016). BillingOverview.tsx wired in PricingPage with useBilling data.
- P7-TS-02: ✅ COMPLETE — Pricing UI (PricingPage, PricingCard, BillingOverview), useBilling hook, checkout success/cancel pages. Stripe webhook handlers. Worker checkout + billing portal endpoints (b1f798a). Entitlement enforcement: `useEntitlements` hook (fail-closed), `check_anchor_quota()` RPC + server-side quota in `bulk_create_anchors()` (migration 0049), `ConfirmAnchorModal` quota gate, `UpgradePrompt` component. Plan change/downgrade via Billing Portal (PR #43). 74 tests. ~~CRIT-3~~ RESOLVED.
- P7-TS-03: ✅ Stripe webhook signature verification works. Mock mode for tests.
- P7-TS-05: ✅ COMPLETE (OPS-ONLY items remain) — `BitcoinChainClient` with provider abstractions: `SigningProvider` (WIF + KMS), `FeeEstimator` (static + mempool), `UtxoProvider` (RPC + Mempool.space). Async factory. `SupabaseChainIndexLookup` for O(1) verification. Migration 0050. 604 worker tests. Signet E2E broadcast verified (TX `b8e381df`). **Remaining operational only:** AWS KMS key provisioning, mainnet treasury funding. See `docs/confluence/15_operational_runbook.md`.
- P7-TS-07: ✅ COMPLETE — PDF + JSON proof package downloads both wired. Fixed in CRIT-5 (commit a38b485).
- P7-TS-08: ✅ `generateAuditReport.ts` — full PDF certificate with jsPDF.
- P7-TS-09: ✅ COMPLETE — WebhookSettings.tsx with two-phase dialog (creation form → one-time secret display). Server-side secret generation via SECURITY DEFINER RPC (migration 0046). 34 tests (23 component + 11 integration).
- P7-TS-10: ✅ COMPLETE — Delivery engine with exponential backoff + HMAC signing. `anchor.ts` dispatches `anchor.secured` webhook after SECURED status set. Webhook retries scheduled in worker cron.
- P7-TS-11: ✅ COMPLETE — Signet treasury wallet utilities (`wallet.ts`: `generateSignetKeypair()`, `addressFromWif()`, `isValidSignetWif()`). CLI scripts (`generate-signet-keypair.ts`, `check-signet-balance.ts`). 13 tests.
- P7-TS-12: ✅ COMPLETE — UTXO provider pattern (`utxo-provider.ts`): `UtxoProvider` interface with `RpcUtxoProvider` (Bitcoin Core JSON-RPC) and `MempoolUtxoProvider` (Mempool.space REST API). Factory function `createUtxoProvider()`. Integrated into `BitcoinChainClient` + `initChainClient()`. 35 tests.
- P7-TS-13: ✅ COMPLETE — `SupabaseChainIndexLookup` for O(1) fingerprint verification. Migration 0050 creates `anchor_chain_index` table. Chain index upsert in `processAnchor()` (non-fatal). Implemented as part of CRIT-2 Steps 5-8.

### P4.5 Verification API — 13/13 COMPLETE

All 13 stories complete. Full Verification API with batch processing, job polling, usage tracking, OpenAPI docs, API key management UI, and load tests. Migration 0057 (api_keys) + 0058 (batch_verification_jobs). Agent discoverability via `.well-known/openapi.json` and `Link` headers.

- P4.5-TS-12: ✅ COMPLETE — Feature gate middleware. TTL-cached (60s) switchboard flag. 503 when disabled. 10 tests.
- P4.5-TS-03: ✅ COMPLETE — API key auth middleware. HMAC-SHA256 hashing, `ak_` prefix, scoped keys, header extraction. 16 tests.
- P4.5-TS-01: ✅ COMPLETE — `GET /api/v1/verify/:publicId`. Frozen response schema. Injectable lookup for testing. 12 tests.
- P4.5-TS-07: ✅ COMPLETE — Key CRUD endpoints (POST/GET/PATCH/DELETE). Audit logging. Zod validation. 13 tests.
- P4.5-TS-05: ✅ COMPLETE — Usage tracking + free tier quota enforcement (10K/month). Quota headers. 11 tests.
- P4.5-TS-02: ✅ COMPLETE — `POST /api/v1/verify/batch`. Sync (≤20 items) + async (>20 items) with job creation. Per-item timeout. 11 tests.
- P4.5-TS-06: ✅ COMPLETE — `GET /api/v1/jobs/:jobId`. Ownership check. Job cleanup for expired (24h). 4 tests.
- P4.5-TS-08: ✅ COMPLETE — `GET /api/v1/usage`. Per-key breakdown. Unlimited tier support. 4 tests.
- P4.5-TS-04: ✅ COMPLETE — OpenAPI 3.0 spec at `/api/docs` (Swagger UI) + `/api/docs/spec.json`. Agent discoverability via `/.well-known/openapi.json`. 9 tests.
- P4.5-TS-09: ✅ COMPLETE — API Key Management UI. `ApiKeySettings` component with two-phase create (form → secret display), revoke/delete with confirmation. `useApiKeys` hook calls worker API. 8 page tests + 8 component tests.
- P4.5-TS-10: ✅ COMPLETE — `ApiUsageDashboard` widget. Progress bar, per-key breakdown, unlimited tier display. 6 tests.
- P4.5-TS-11: ✅ COMPLETE — `ApiKeyScopeDisplay` component. Scope badges (verify/batch/usage) with color coding. Compact mode. 4 tests.
- P4.5-TS-13: ✅ COMPLETE — Rate limit load tests. Anonymous (100/min), keyed (1000/min), batch (10/min). Concurrent simulation (500 requests). Window reset. 12 tests.

### DH Deferred Hardening — 12/12 COMPLETE

All 12 stories complete. DH-03 (PR #26), DH-07 (PR #38), DH-09 (PR #39) completed individually. Remaining 9 stories (DH-01, DH-02, DH-04, DH-05, DH-06, DH-08, DH-10, DH-11, DH-12) completed in DH Hardening Sprint (PR #49, migration 0052). See `docs/stories/10_deferred_hardening.md` for full details.

~~DH-01~~ Feature flag hot-reload · ~~DH-02~~ Advisory lock (migration 0052) · ~~DH-03~~ KMS operational docs (`14_kms_operations.md`) · ~~DH-04~~ Webhook circuit breaker · ~~DH-05~~ Chain index cache TTL · ~~DH-06~~ Quota error handling · ~~DH-07~~ Fee estimator timeout (PR #38) · ~~DH-08~~ Rate limiting (migration 0052) · ~~DH-09~~ UTXO retry logic (PR #39) · ~~DH-10~~ Entitlements realtime · ~~DH-11~~ RPC structured logging · ~~DH-12~~ Webhook DLQ (migration 0052)

### MVP Launch Gaps — 25/27 COMPLETE, 2/27 NOT STARTED (2 REMOVED)

27 active stories (2 removed as superseded by P8). See `docs/stories/11_mvp_launch_gaps.md` for full details.

| ID | Priority | Description | Status |
|----|----------|-------------|--------|
| ~~MVP-01~~ | ~~CRITICAL~~ | ~~Worker production deployment (GCP Cloud Run)~~ | ✅ COMPLETE (OPS-ONLY items remain) — `.env.example` updated, deploy workflow, health check (PR #50). Operational runbook at `docs/confluence/15_operational_runbook.md`. |
| ~~MVP-02~~ | ~~HIGH~~ | ~~Global toast/notification system (Sonner)~~ | ✅ COMPLETE — All mutation hooks have toasts: useProfile, useOrganization, useBulkAnchors, useAnchors, useCredentialTemplates, useRevokeAnchor, useInviteMember. |
| ~~MVP-03~~ | ~~HIGH~~ | ~~Legal pages (Privacy, Terms, Contact)~~ | ✅ COMPLETE — PrivacyPage, TermsPage, ContactPage exist + routed |
| ~~MVP-04~~ | ~~HIGH~~ | ~~Brand assets (logo, favicon, OG meta tags)~~ | ✅ COMPLETE (PR #30) — ArkovaLogo, favicon.svg, og-image.svg, OG/Twitter meta |
| ~~MVP-05~~ | ~~HIGH~~ | ~~Error boundary + 404 page~~ | ✅ COMPLETE — ErrorBoundary (Sentry-wired) + NotFoundPage, both routed |
| ~~MVP-06~~ | ~~MEDIUM~~ | ~~File-based public verification (drag-and-drop)~~ | ✅ COMPLETE (PR #50) — `/verify` route, client-side fingerprinting, PublicVerifyPage tests |
| ~~MVP-07~~ | ~~MEDIUM~~ | ~~Mobile responsive layout~~ | ✅ COMPLETE (PR #43) |
| ~~MVP-08~~ | ~~MEDIUM~~ | ~~Onboarding progress stepper~~ | ✅ COMPLETE (PR #44) |
| ~~MVP-09~~ | ~~MEDIUM~~ | ~~Records pagination + search~~ | ✅ COMPLETE (PR #44) |
| ~~MVP-10~~ | ~~MEDIUM~~ | ~~Marketing website (arkova.ai)~~ | ✅ COMPLETE — Built as separate Vite+React project. Nordic Vault aesthetic. GitHub: `carson-see/arkova-marketing`. Pending: Vercel deployment + custom domain. |
| ~~MVP-11~~ | ~~HIGH~~ | ~~Stripe plan change/downgrade~~ | ✅ COMPLETE (PR #43) — via Billing Portal |
| MVP-12 | LOW | Dark mode toggle | NOT STARTED |
| MVP-13 | LOW | Organization logo upload | NOT STARTED |
| MVP-14 | LOW | Embeddable verification widget | NOT STARTED |
| ~~MVP-16~~ | ~~MEDIUM~~ | ~~Block explorer deep links~~ | ✅ COMPLETE (PR #50) — ExplorerLink component, wired in PublicVerification |
| ~~MVP-17~~ | ~~MEDIUM~~ | ~~Credential template metadata enhancement~~ | ✅ COMPLETE — TemplateSchemaBuilder component (6 field types). 9 tests. |
| ~~MVP-18~~ | ~~MEDIUM~~ | ~~Enhanced metadata display~~ | ✅ COMPLETE — MetadataDisplay component (auto-formatting, schema labels). 13 tests. |
| ~~MVP-19~~ | — | ~~AI Auto-Descriptions~~ — REMOVED (superseded by P8-S4/S5) | — |
| MVP-20 | LOW | LinkedIn badge integration | NOT STARTED |
| ~~MVP-21~~ | ~~MEDIUM~~ | ~~Individual self-verification flow~~ | ✅ COMPLETE (PR #50) — VerifyMyRecordPage at `/my-records/verify` |
| ~~MVP-22~~ | — | ~~AI Fraud Detection~~ — REMOVED (superseded by P8-S7/S8/S9) | — |
| ~~MVP-23~~ | ~~MEDIUM~~ | ~~Batch anchor processing~~ | ✅ COMPLETE — Merkle tree + batch anchor job. `ENABLE_BATCH_ANCHORING` flag. 30 tests. |
| ~~MVP-24~~ | ~~HIGH~~ | ~~Credits schema + monthly allocations~~ | ✅ COMPLETE (PR #50) — Migration 0053, RPCs, RLS |
| ~~MVP-25~~ | ~~MEDIUM~~ | ~~Credits tracking + scheduling~~ | ✅ COMPLETE (PR #50) — useCredits hook, CreditUsageWidget, cron job |
| ~~MVP-26~~ | ~~HIGH~~ | ~~GCP Cloud Run deployment~~ | ✅ COMPLETE — `arkova-worker-kvojbeutfa-uc.a.run.app`, health verified, all secrets mounted. |
| ~~MVP-27~~ | ~~HIGH~~ | ~~GCP Secret Manager integration~~ | ✅ COMPLETE — 7 secrets (supabase-url, supabase-service-role-key, stripe-secret-key, stripe-webhook-secret, cloudflare-tunnel-token, bitcoin-treasury-wif, api-key-hmac-secret). |
| ~~MVP-28~~ | ~~MEDIUM~~ | ~~GCP Cloud Scheduler~~ | ✅ COMPLETE — 4 cron jobs created (process-anchors, webhook-retries, generate-reports, credit-expiry). OIDC auth with Cloud Run SA. |
| ~~MVP-29~~ | ~~HIGH~~ | ~~GCP Cloud KMS integration~~ | ✅ COMPLETE — `GcpKmsSigningProvider` + factory + config. `KMS_PROVIDER=aws\|gcp`. 14 tests. |
| MVP-30 | MEDIUM | GCP CI/CD pipeline | NOT STARTED |

**Bugs linked:** ~~BUG-AUDIT-01~~ (→MVP-02 RESOLVED), ~~BUG-AUDIT-02~~ (→MVP-03 RESOLVED), ~~BUG-AUDIT-03~~ (→MVP-04 RESOLVED).

### P8 AI Intelligence — 15/19 COMPLETE, 4/19 NOT STARTED

19 stories for AI-powered document intelligence. Phase I (6 stories) + Phase 1.5 (5 stories) + 4 infrastructure stories complete:
- ~~P8-S1~~ ✅ Gemini API Integration — `GeminiProvider` implementing `IAIProvider`, structured JSON output, retry + circuit breaker, Zod schemas, prompt templates. 13 tests.
- ~~P8-S2~~ ✅ AI Cost Tracking — Migration 0059 (`ai_credits` + `ai_usage_events`), `cost-tracker.ts`, `check_ai_credits`/`deduct_ai_credits` RPCs, `GET /api/v1/ai/usage`. 17 tests.
- ~~P8-S3~~ ✅ AI Feature Flags — `ENABLE_AI_EXTRACTION`, `ENABLE_SEMANTIC_SEARCH`, `ENABLE_AI_FRAUD` in switchboard + seed SQL. `aiFeatureGate.ts` middleware. 17 tests.
- ~~P8-S4~~ ✅ AI Extraction Service — `POST /api/v1/ai/extract` endpoint. PII-stripped metadata in → structured fields out. Credit check + deduction. Feature flag gate. Audit logging. 6 tests.
- ~~P8-S5~~ ✅ AI Extraction UI — `ocrWorker.ts` (PDF.js + Tesseract.js), `aiExtraction.ts` (orchestrator: OCR → stripPII → API → render), `AIFieldSuggestions.tsx` (confidence badges, accept/reject/edit). 18 tests.
- ~~P8-S7~~ ✅ Cloudflare Crawler (institution ingestion) — `services/edge/src/institution-crawler.ts`, 5 tests
- ~~P8-S10~~ ✅ pgvector Embedding Schema — Migration 0060 (`credential_embeddings` table, HNSW index, org-scoped RLS, 2 SECURITY DEFINER RPCs).
- ~~P8-S11~~ ✅ Embedding Generation Pipeline — `embeddings.ts` service + `POST /api/v1/ai/embed` + batch endpoint. Credit check/deduction, source text hashing. 18 tests.
- ~~P8-S12~~ ✅ Semantic Search UI — `GET /api/v1/ai/search` endpoint + `SemanticSearch` component + `useSemanticSearch` hook. Nordic Vault aesthetic. 20 tests.
- ~~P8-S13~~ ✅ Batch AI Processing (Cloudflare Queues) — `services/edge/src/batch-queue.ts`, 4 tests
- ~~P8-S14~~ ✅ Batch AI Dashboard — `BatchAIDashboard` component with glass-card, shimmer, auto-refresh. 5 tests.
- ~~P8-S15~~ ✅ R2 Report Storage (zero-egress signed URLs) — `services/edge/src/report-generator.ts`, 4 tests
- ~~P8-S17~~ ✅ AI Provider Abstraction (IAIProvider + factory) — `services/worker/src/ai/`, 16 tests
- ~~P8-S18~~ ✅ Client-Side PII Stripping — `piiStripper.ts` with `stripPII()`. Regex for SSN, phone, email, DOB, student ID, name matching. Returns `StrippingReport`. 27 tests.
- ~~P8-S19~~ ✅ Agentic Verification Endpoint — `GET /api/v1/verify/search` with frozen schema results, API key auth, similarity scores. 5 tests.

Remaining 4 stories NOT STARTED (Phase II). See `docs/stories/12_p8_ai_intelligence.md` for full details.

### INFRA Edge & Ingress — 7/8 COMPLETE, 1/8 PARTIAL, 0/8 NOT STARTED

8 stories for Zero Trust ingress, edge compute, observability, and AI provider fallback. See `docs/stories/13_infrastructure_edge.md`.

| ID | Status | Description |
|----|--------|-------------|
| ~~INFRA-01~~ | ~~✅ COMPLETE~~ | ~~Cloudflare Tunnel sidecar — Dockerfile + entrypoint.sh + docker-compose.yml with profile-based tunnel. 25 tests.~~ |
| ~~INFRA-02~~ | ~~✅ COMPLETE~~ | ~~Wrangler + edge scaffolding — `services/edge/` with 11 source files, `wrangler.toml`, `tsconfig.json`. Full implementation.~~ |
| ~~INFRA-03~~ | ~~✅ COMPLETE~~ | ~~R2 report storage — binding in wrangler.toml, `report-generator.ts` + `report-logic.ts` implemented. 4 tests.~~ |
| ~~INFRA-04~~ | ~~✅ COMPLETE~~ | ~~Batch anchor queue — binding in wrangler.toml, `batch-queue.ts` + `batch-queue-logic.ts` with Zod schema. 4 tests.~~ |
| ~~INFRA-05~~ | ~~✅ COMPLETE~~ | ~~AI fallback provider — `IAIProvider` interface, `CloudflareAIFallbackProvider`, factory, mock, 16 tests. Edge worker `ai-fallback.ts`.~~ |
| ~~INFRA-06~~ | ~~✅ COMPLETE~~ | ~~Replicate QA data generator — `ReplicateProvider` implementing `IAIProvider`. Production-blocked. 12 tests.~~ |
| INFRA-07 | ⚠️ PARTIAL | Sentry integration — `@sentry/react` + `@sentry/node` + `@sentry/profiling-node` installed. Frontend + worker init, PII scrubbing, ErrorBoundary wired, 30 tests. Missing: source map upload plugin, DSN env vars in production. |
| ~~INFRA-08~~ | ~~✅ COMPLETE~~ | ~~pgvector + institution ground truth — migration 0051 applied to production.~~ |

### UF User Flow Gaps — 10/10 COMPLETE

10 stories identified 2026-03-16 from full user flow walkthrough. All complete across Sprints A, B, and C. See `docs/stories/14_user_flow_gaps.md`.

| ID | Priority | Description | Status |
|----|----------|-------------|--------|
| ~~UF-01~~ | ~~CRITICAL~~ | ~~Template-based credential rendering (CredentialRenderer component)~~ | ✅ COMPLETE — CredentialRenderer (3 modes), useCredentialTemplate hook, get_public_template RPC (migration 0054). 20 tests. |
| ~~UF-02~~ | ~~HIGH~~ | ~~Public credential discovery + search (/search, /issuer/:orgId)~~ | ✅ COMPLETE — SearchPage + IssuerRegistryPage, search_public_issuers + get_public_issuer_registry RPCs, migration 0055. |
| ~~UF-03~~ | ~~HIGH~~ | ~~Individual recipient credential inbox (/my-credentials, anchor_recipients table)~~ | ✅ COMPLETE — anchor_recipients table (migration 0056), useMyCredentials hook, MyCredentialsPage, hashEmail for privacy-preserving recipient matching, auto-link on signup trigger. |
| ~~UF-04~~ | ~~CRITICAL~~ | ~~Anchor status lifecycle UX (PENDING → SECURED visibility + messaging)~~ | ✅ COMPLETE — Enhanced success screens (SecureDocumentDialog + IssueCredentialForm), pulsing amber PENDING badges (OrgRegistryTable), public verification includes PENDING with "Anchoring In Progress" banner. Migration 0054 updates get_public_anchor. |
| ~~UF-05~~ | ~~HIGH~~ | ~~Credential metadata entry in issuance forms (dynamic fields from template)~~ | ✅ COMPLETE — Dynamic form fields from template schema, MetadataFieldRenderer, seed template schemas (DIPLOMA, CERTIFICATE, LICENSE). |
| ~~UF-06~~ | ~~HIGH~~ | ~~Usage/quota tracking dashboard (UsageWidget, proactive warnings)~~ | ✅ COMPLETE — UsageWidget component, usage progress bar on Dashboard + PricingPage, 80%/100% warning toasts, credit balance display. |
| ~~UF-07~~ | ~~HIGH~~ | ~~Enhanced public verification display (issuer info, revocation details, proof download)~~ | ✅ COMPLETE — RevocationDetails component, VerifierProofDownload, issuer section with public registry link, mobile-optimized layout. |
| ~~UF-08~~ | ~~MEDIUM~~ | ~~Post-issuance actions + share flow (copy link, share sheet)~~ | ✅ COMPLETE — ShareSheet component (copy link, QR code, email), OrgRegistryTable copy link row action, success screen action buttons. |
| ~~UF-09~~ | ~~MEDIUM~~ | ~~Org context + navigation polish (breadcrumbs, org name, auth redirect toast)~~ | ✅ COMPLETE — Breadcrumbs component, org name in sidebar ("MANAGING: OrgName"), auth redirect toast, Settings privacy description, Sign Out button. |
| ~~UF-10~~ | ~~MEDIUM~~ | ~~Onboarding completion + empty state guidance (getting started checklist)~~ | ✅ COMPLETE — GettingStartedChecklist (role-specific, localStorage-persisted, progress bar), enhanced empty states with CTAs. |

**Build order:** ~~Sprint A: UF-01 + UF-04~~ (DONE) → ~~Sprint B: UF-05, UF-02, UF-06, UF-07~~ (DONE) → ~~Sprint C: UF-03, UF-08, UF-09, UF-10~~ (DONE)

---

## 9. EXECUTION ORDER — CURRENT SPRINT

> **Goal:** Production launch of Phase 1 credentialing MVP.
> For detailed task assignments and owner context, see MEMORY.md.

### Completed (sprint archive)

All of the following are done. Details in MEMORY.md completed sprints.

- ✅ CRIT-1 fix (SecureDocumentDialog real insert)
- ✅ CRIT-4 fix (onboarding routes wired)
- ✅ CRIT-5 fix (JSON proof download wired)
- ✅ CRIT-6 fix (CSVUploadWizard wired to useBulkAnchors)
- ✅ CRIT-7 fix (Ralph → Arkova branding)
- ✅ Worker hardening sprint (275 worker tests, 80%+ thresholds on all critical paths)
- ✅ E2E test suite (86 specs + 25 load + 5 perf)
- ✅ SonarQube remediation (~100 issues, 24 hotspots)
- ✅ P7-TS-09 webhook settings (migration 0046, 34 tests)
- ✅ P7-TS-10 webhook delivery engine (HMAC signing, exponential backoff)
- ✅ Stripe checkout + billing portal worker endpoints (b1f798a)
- ✅ SignetChainClient (bitcoinjs-lib OP_RETURN, `ARKV` prefix)
- ✅ P7-TS-11 Signet wallet setup (wallet.ts, CLI scripts, 13 tests)
- ✅ P7-TS-12 UTXO provider pattern (RPC + Mempool.space backends, 35 tests)
- ✅ Production Supabase deployed (51 migrations, seed data, Stripe Price IDs set)
- ✅ database.types.ts regenerated from production (22 tables, 16 functions, 6 enums) — PR #29
- ✅ Phase 0 tooling (edge scaffolding, tunnel config, Sentry/CF deps, scripts) — PR #29
- ✅ MVP-04 brand assets (ArkovaLogo, favicon.svg, OG meta tags) — PR #30
- ✅ Sentry integration + AI provider scaffolding + edge worker implementation — PR #31
- ✅ MCP server + verify-anchor API endpoint + vulnerability fixes — PR #31
- ✅ MVP-03 legal pages (PrivacyPage, TermsPage, ContactPage — exist + routed)
- ✅ MVP-05 error boundary + 404 (ErrorBoundary + NotFoundPage — exist + routed + Sentry-wired)
- ✅ UF Sprint A: UF-01 (CredentialRenderer) + UF-04 (PENDING status UX) — PR #60, migration 0054
- ✅ UF Sprint B: UF-05 (metadata entry) + UF-02 (public search) + UF-06 (usage dashboard) + UF-07 (enhanced verification) — PR #61, migration 0055
- ✅ UF Sprint C: UF-03 (recipient inbox) + UF-08 (share flow) + UF-09 (nav polish) + UF-10 (onboarding) — PR #62, migration 0056
- ✅ MVP-26 GCP Cloud Run deployment + MVP-27 GCP Secret Manager + MVP-28 GCP Cloud Scheduler

### Current: Remaining Production Blockers

| Task | Blocker | Detail |
|------|---------|--------|
| AWS KMS signing | CRIT-2 | Key provisioning for mainnet signing. SignetChainClient done, mainnet needs KMS. |
| ~~Signet node connectivity test~~ | ~~CRIT-2~~ | ~~DONE — Signet E2E broadcast verified (TX `b8e381df`).~~ |
| Mainnet treasury funding | CRIT-2 | Fund the production treasury wallet. |
| ~~Entitlement enforcement~~ | ~~CRIT-3~~ | ~~RESOLVED 2026-03-14 (PR #43). Plan change/downgrade via Billing Portal.~~ |

### MVP Launch Gap Stories (testnet launch blockers)

| Task | Story | Priority | Detail |
|------|-------|----------|--------|
| Worker deployment | MVP-01 | CRITICAL | Deploy Express worker to production host. Blocks all anchor processing. `.env.example` + deploy workflow updated (PR #50). |
| ~~Toast system~~ | ~~MVP-02~~ | ~~HIGH~~ | ~~RESOLVED 2026-03-15. All mutation hooks have toasts (audit confirmed).~~ |
| ~~Legal pages~~ | ~~MVP-03~~ | ~~HIGH~~ | ~~RESOLVED 2026-03-14. PrivacyPage + TermsPage + ContactPage exist + routed.~~ |
| ~~Brand assets~~ | ~~MVP-04~~ | ~~HIGH~~ | ~~RESOLVED 2026-03-14. ArkovaLogo component, favicon.svg, OG meta tags. PR #30.~~ |
| ~~Error boundary~~ | ~~MVP-05~~ | ~~HIGH~~ | ~~RESOLVED 2026-03-14. ErrorBoundary (Sentry-wired) + NotFoundPage, both routed.~~ |
| ~~Stripe plan change~~ | ~~MVP-11~~ | ~~HIGH~~ | ~~RESOLVED 2026-03-14 (PR #43). Via Billing Portal.~~ |

### Pre-Launch (after blockers + MVP gaps resolved)

| Task | Detail |
|------|--------|
| ~~Supabase production~~ | ~~DONE 2026-03-13. Project `vzwyaatejekddvltxyye` provisioned, 51 migrations applied, seed data loaded, Stripe Price IDs configured.~~ |
| ~~Vercel production~~ | ~~DONE 2026-03-13. `arkova-carson.vercel.app` deployed with production Supabase env vars.~~ |
| DNS + custom domain | `app.arkova.io` or equivalent. |
| Seed data strip | Remove demo users. |
| Marketing website | MVP-10: arkova.ai public site with pricing, features, CTA. |
| SOC 2 evidence | Begin collection (CI logs, RLS tests, audit events). |

### Do NOT Start

- ~~P4.5 (Verification API) — defer to post-launch~~ (COMPLETE 13/13)
- AI/OCR pipeline — Phase 2
- OpenTimestamps — decision made, direct OP_RETURN only
- ~~MVP-12 (dark mode)~~ (COMPLETE — useTheme hook + ThemeToggle in Sidebar)
- MVP-13/14 (org logo, embed widget) — post-launch polish

---

## 10. PHASE 1.5 REFERENCE (Verification API — POST-LAUNCH)

Build order (dependency-ordered):

| # | Story | Task | Dep |
|---|-------|------|-----|
| 1 | P4.5-TS-12 | Feature flag middleware | None |
| 2 | P4.5-TS-03 | API keys table + HMAC + rate limiting | P1-TS-03 |
| 3 | P4.5-TS-01 | GET `/api/v1/verify/:publicId` | P6-TS-01 |
| 4 | P4.5-TS-06 | GET `/api/v1/jobs/:jobId` | P4.5-TS-03 |
| 5 | P4.5-TS-02 | POST `/api/v1/verify/batch` | P4.5-TS-01 |
| 6 | P4.5-TS-07 | Key CRUD endpoints | P4.5-TS-03 |
| 7 | P4.5-TS-05 | Free tier enforcement (10K/month) | P4.5-TS-03 |
| 8 | P4.5-TS-08 | GET `/api/v1/usage` | P4.5-TS-05 |
| 9 | P4.5-TS-04 | OpenAPI docs (`/api/docs`) | All above |
| 10 | P4.5-TS-09 | API Key Management UI | P4.5-TS-07 |
| 11 | P4.5-TS-10 | API Usage Dashboard Widget | P4.5-TS-05 |
| 12 | P4.5-TS-11 | API Key Scope Display | P4.5-TS-09 |
| 13 | P4.5-TS-13 | Rate limit load tests | All deployed |

**Frozen response schema:**

```json
{
  "verified": true,
  "status": "ACTIVE | REVOKED | SUPERSEDED | EXPIRED",
  "issuer_name": "string",
  "recipient_identifier": "string (hashed, never raw PII)",
  "credential_type": "string",
  "issued_date": "string | null",
  "expiry_date": "string | null",
  "anchor_timestamp": "string",
  "bitcoin_block": "number | null",
  "network_receipt_id": "string | null",
  "merkle_proof_hash": "string | null",
  "record_uri": "https://app.arkova.io/verify/{public_id}",
  "jurisdiction": "string (omitted when null, not returned as null)"
}
```

**Architecture Decision (ADR-001):** `record_uri` uses HTTPS (`https://app.arkova.io/verify/{public_id}`). No custom protocol handlers.

**File placement:**
- API routes: `services/worker/src/api/`
- Middleware: `services/worker/src/middleware/`
- Zod schemas: `services/worker/src/schemas/`
- API key UI: `src/components/api/ApiKeySettings.tsx` + `src/pages/ApiKeySettingsPage.tsx`
- Load tests: `tests/load/`

---

## 11. TESTING REFERENCE

### RLS Tests
```typescript
import { withUser, withAuth } from '../tests/rls/helpers';

it('blocks cross-tenant access', async () => {
  await withUser(userFromOrgA, async (client) => {
    const { data } = await client.from('anchors').select();
    expect(data).toEqual([]);
  });
});
```

### Worker Tests
```typescript
const mockPayment: IPaymentProvider = { createCheckout: vi.fn() };
const mockChain: IAnchorPublisher = {
  publishAnchor: vi.fn().mockResolvedValue({ txId: 'mock_tx' })
};
```

### Gherkin → Test Mapping
- `Given` → test setup / `beforeEach`
- `When` → the action
- `Then` / `And` → `expect()` assertions

### Demo Users (Seed Data)

| Email | Password | Role | Org |
|-------|----------|------|-----|
| admin_demo@arkova.local | demo_password_123 | ORG_ADMIN | Arkova |
| user_demo@arkova.local | demo_password_123 | INDIVIDUAL | None |
| beta_admin@betacorp.local | demo_password_123 | ORG_ADMIN | Beta Corp |

---

## 12. COMMON MISTAKES — DO NOT DO THESE

| Mistake | Why It's Wrong | Do This Instead |
|---------|---------------|-----------------|
| `useState` for records from a Supabase table | Violates schema-first; stale data | Create a `useXxx()` hook querying Supabase |
| `supabase.insert()` without `validateAnchorCreate()` | Skips validation, allows forbidden fields | Always call Zod validator first |
| SECURITY DEFINER without `SET search_path = public` | Search path injection vulnerability | Always add it |
| User-visible text directly in JSX | No copy lint coverage, terminology drift | Add to `src/lib/copy.ts` first |
| Schema change without `gen:types` | TypeScript types out of sync | `supabase gen types typescript --local` |
| Real Stripe/Bitcoin calls in tests | CI breaks, flaky | Use mock interfaces |
| Setting `anchor.status = 'SECURED'` from client | Only worker via service_role | Let worker set SECURED |
| Exposing `user_id`, `org_id`, `anchors.id` on public page | Privacy violation | Only `public_id` + derived fields |
| `href="#"` for navigation | Dead link | `<Link to="/path">` from react-router-dom |
| Raw secrets in code | Security critical | Environment variables only |
| `jurisdiction: null` in API response | Frozen schema: omit when null | Conditional spread: `...(jurisdiction && { jurisdiction })` |
| Raw API key in DB | Security violation | HMAC-SHA256 hash with `API_KEY_HMAC_SECRET` |
| `generateFingerprint` in worker | Constitution violation | Fingerprinting is client-side only |
| `arkova://rec/` URI format | ADR-001: use HTTPS | `https://app.arkova.io/verify/{public_id}` |
| Following old `SecureDocumentDialog` pattern (pre-CRIT-1 fix) | Old version used setTimeout simulation | Follow `IssueCredentialForm` pattern — both now use real Supabase inserts |

---

## 13. ENVIRONMENT VARIABLES

Never commit. Load from `.env` (gitignored). Worker fails loudly if required vars missing.

```bash
# Supabase (browser)
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=

# Supabase (worker only — never in browser)
SUPABASE_URL=                       # worker uses non-VITE prefixed URL
SUPABASE_SERVICE_ROLE_KEY=

# Stripe (worker only)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# Bitcoin (worker only)
BITCOIN_TREASURY_WIF=               # signing key — never logged (Constitution 1.4)
BITCOIN_NETWORK=                    # "testnet4" (recommended), "signet", "testnet", or "mainnet"
BITCOIN_RPC_URL=                    # optional — Signet/mainnet RPC endpoint
BITCOIN_RPC_AUTH=                   # optional — RPC auth credentials

# Legacy chain API (backward compat)
CHAIN_API_URL=                      # optional
CHAIN_API_KEY=                      # optional
CHAIN_NETWORK=                      # "testnet" or "mainnet" (default: testnet)

# Worker
WORKER_PORT=3001                    # default: 3001
NODE_ENV=development
LOG_LEVEL=info                      # debug | info | warn | error
FRONTEND_URL=http://localhost:5173  # CORS origin for worker endpoints
USE_MOCKS=false                     # use mock chain/stripe clients
ENABLE_PROD_NETWORK_ANCHORING=false # gates real Bitcoin chain calls (Constitution 1.9)

# Verification API (worker only — Phase 1.5)
ENABLE_VERIFICATION_API=false
API_KEY_HMAC_SECRET=
CORS_ALLOWED_ORIGINS=*

# Cron job authentication (AUTH-01)
CRON_SECRET=                        # shared secret for X-Cron-Secret header (min 16 chars)
CRON_OIDC_AUDIENCE=                 # Cloud Run service URL for OIDC audience verification

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

# Gemini AI (P8 — worker only)
GEMINI_API_KEY=                    # Google AI Studio key
GEMINI_MODEL=gemini-2.0-flash     # Extraction model (default: gemini-2.0-flash)
GEMINI_EMBEDDING_MODEL=text-embedding-004  # Embedding model
AI_PROVIDER=mock                   # gemini | cloudflare | replicate | mock
```

---

_Directive version: 2026-03-16 (All 12 CISO security findings resolved — AUTH-01, SEC-01 complete) | Repo: ArkovaCarson | 63 migrations | 1,745 tests | 163 stories (146 complete, 90%)_
_Companion: MEMORY.md (living state) | Technical Backlog P1-P7 | Phase 1.5 Backlog | Business Backlog P1-P7_