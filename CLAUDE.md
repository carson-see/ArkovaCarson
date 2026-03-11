# ARKOVA — Claude Code Engineering Directive

> **Version:** 2026-03-11 (comprehensive audit update)
> **Repo:** ArkovaCarson | **Branch:** main | **Deploy:** arkova-carson.vercel.app
> **Companion file:** `MEMORY.md` (living state — decisions, blockers, sprint context)

Claude Code reads this file automatically before every task. It contains the rules, the repo map, and the current story status. If something conflicts with MEMORY.md, this file wins on rules; MEMORY.md wins on current state.

---

## 0. READ FIRST — EVERY SESSION

```
1. CLAUDE.md          ← You are here. Rules, Constitution, story status.
2. MEMORY.md          ← Living state. Blockers, decisions, sprint context, handoff notes.
3. docs/confluence/01_architecture_overview.md  ← If it exists.
4. The relevant agents.md in any folder you are about to edit.
5. The story card from the Technical Backlog for the story you are implementing.
```

If a folder contains an `agents.md`, read it before touching anything. If you learn something important during your work, update that folder's `agents.md` AND the "Session Handoff Notes" section of MEMORY.md.

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

**Hard constraints:**
- Never use Next.js API routes for long-running jobs
- New AI libraries require explicit architecture review before introduction
- No server-side document processing — ever (see 1.6)

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
- Future AI pipeline: client-side OCR (PDF.js + Tesseract.js), server-side LLM on extracted text only.

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
    anchor/                                  ← SecureDocumentDialog, FileUpload, AssetDetailView
    auth/                                    ← LoginForm, SignUpForm, AuthGuard, RouteGuard
    billing/                                 ← BillingOverview, PricingCard
    credentials/                             ← CredentialTemplatesManager
    dashboard/                               ← StatCard, EmptyState
    embed/                                   ← VerificationWidget (orphaned — not wired)
    layout/                                  ← AppShell, Header, Sidebar, AuthLayout
    onboarding/                              ← RoleSelector, OrgOnboardingForm, ManualReviewGate, EmailConfirmation
    organization/                            ← IssueCredentialForm, MembersTable, RevokeDialog, OrgRegistryTable
    public/                                  ← PublicVerifyPage, ProofDownload
    records/                                 ← RecordsList
    reports/                                 ← ReportsList
    upload/                                  ← BulkUploadWizard, CSVUploadWizard, CsvUploader
    vault/                                   ← VaultDashboard
    verification/                            ← PublicVerification (5-section result display)
    verify/                                  ← VerificationForm
    webhooks/                                ← WebhookSettings
  hooks/                                     ← useAuth, useAnchors, useProfile, useOnboarding, etc.
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
  pages/                                     ← Page components (thin wrappers around domain components)
  types/database.types.ts                    ← Auto-generated from Supabase — never edit manually
  tests/rls/                                 ← RLS integration test helpers
services/worker/
  src/
    index.ts                                 ← Express server + cron + graceful shutdown
    config.ts                                ← Environment config
    chain/client.ts                          ← ChainClient factory (returns MockChainClient or SignetChainClient)
    chain/signet.ts                          ← Real Signet implementation (bitcoinjs-lib, OP_RETURN)
    chain/mock.ts                            ← Mock implementation
    chain/types.ts                           ← ChainClient interface (IAnchorPublisher equivalent)
    jobs/anchor.ts                           ← Process pending anchors
    jobs/report.ts                           ← Report generation job
    jobs/webhook.ts                          ← Webhook dispatch job (stub)
    stripe/client.ts                         ← Stripe SDK + webhook signature verification
    stripe/handlers.ts                       ← Webhook event handlers
    stripe/mock.ts                           ← Mock Stripe for tests
    webhooks/delivery.ts                     ← Outbound webhook delivery engine
    utils/                                   ← DB client, logger, rate limiter, correlation ID
supabase/
  migrations/                                ← 48 files (0001–0048, 0033 skipped)
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

## 5. BRAND APPLICATION

### Brand Colors

| Name | Hex | HSL | Usage |
|------|-----|-----|-------|
| Steel Blue | `#82b8d0` | 197 42% 66% | Primary / buttons / links |
| Charcoal | `#303433` | 156 4% 19% | Sidebar background / foreground |
| Ice Blue | `#dbeaf1` | 199 44% 90% | Secondary / light backgrounds |

### CSS Custom Properties

The `:root` and `.dark` blocks in `src/index.css` define all theme tokens. The Arkova palette is already applied (Steel Blue as primary, Charcoal as sidebar). See `tailwind.config.ts` for the `arkova.*` color scale.

### Brand Rules for New Components
- Sidebar: `bg-arkova-charcoal` or `bg-sidebar-background`
- Primary buttons: `bg-primary` (Steel Blue)
- Status badges: SECURED=green, PENDING=amber, REVOKED=gray, EXPIRED=gray
- Fingerprint display: `font-mono text-xs bg-muted rounded px-2 py-1`
- Logo on dark backgrounds: white wordmark + light blue bear
- Logo on white: full-color as-is

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

All docs live in `docs/confluence/` and are numbered 00–13 (14 files total). The index (`00_index.md`) lists all documents with descriptions and a suggested reading order.

Every doc must include:
- `_Last updated: [date] | Story: [story ID]_` line below the title
- Schema docs reference specific migration numbers (e.g., "migration 0016")
- Implementation status tables distinguish **Complete / Partial / Not Started**
- Change log at the bottom tracking audit history
- Cross-references use relative markdown links (e.g., `[02_data_model.md](./02_data_model.md)`)

When a doc describes something that is partially implemented or a known gap exists, document it explicitly — never imply that something works if it doesn't.

### Story Documentation (`docs/stories/`)

Story docs live in `docs/stories/` and are grouped by priority level (one file per group). The index (`00_stories_index.md`) lists all 56 stories with status, group doc reference, and bug cross-references.

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

**Current migration inventory:** 48 files, versions 0001–0048 (0033 intentionally skipped). Last: `0048_consolidate_get_public_anchor_single_read.sql`.

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
| P6 Verification | 5/6 | 1/6 | 0 | 83% |
| P7 Go-Live | 8/13 | 2/13 | 3/13 | 62% |
| P4.5 Verification API | 0/13 | 0/13 | 13/13 | 0% |
| **Total** | **39/58** | **3/58** | **16/58** | **~72%** |

### Critical Blockers (resolve before production)

| ID | Issue | Severity | Detail |
|----|-------|----------|--------|
| ~~CRIT-1~~ | ~~`SecureDocumentDialog` fakes anchor creation~~ | ~~HIGH~~ | ~~RESOLVED 2026-03-10. Real Supabase insert replacing setTimeout simulation. Commit a38b485.~~ |
| CRIT-2 | No real Bitcoin chain client | **HIGH** | SignetChainClient implemented with `bitcoinjs-lib` OP_RETURN (`ARKV` prefix). Factory updated. Wallet utilities + CLI scripts (P7-TS-11). **Remaining:** Fund Signet treasury via faucet, Signet node connectivity test, AWS KMS signing (mainnet), mainnet treasury funding. |
| CRIT-3 | No Stripe checkout flow | **HIGH** | Pricing UI + useBilling hook + checkout pages + checkout/portal worker endpoints all implemented (b1f798a). Webhook handlers work. **Remaining:** entitlement enforcement, plan change/downgrade. |
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

### P6 Verification — 5/6 COMPLETE, 1/6 PARTIAL

- P6-TS-01: ✅ `get_public_anchor` RPC rebuilt (migration 0044). PublicVerification.tsx renders 5 sections. Wired to `/verify/:publicId`.
- P6-TS-02: ✅ QRCodeSVG in AssetDetailView for SECURED anchors. Links to `/verify/{publicId}`.
- P6-TS-03: ⚠️ PARTIAL — `VerificationWidget.tsx` exists but **never imported or routed**. Not bundled as standalone embed.
- P6-TS-04: ✅ COMPLETE — `AnchorLifecycleTimeline` wired into PublicVerification.tsx Section 5. `mapToLifecycleData()` maps snake_case RPC fields to camelCase props. Shows on both detail and public pages.
- P6-TS-05: ✅ `generateAuditReport.ts` (jsPDF, 201 lines). Called from RecordDetailPage.
- P6-TS-06: ✅ `verification_events` table (migration 0042), SECURITY DEFINER RPC (migration 0045), wired into PublicVerification.tsx.

### P7 Go-Live — 8/13 COMPLETE, 2/13 PARTIAL, 3/13 NOT STARTED

- P7-TS-01: ✅ Billing schema (migration 0016). BillingOverview.tsx wired in PricingPage with useBilling data.
- P7-TS-02: ⚠️ PARTIAL — Pricing UI (PricingPage, PricingCard, BillingOverview), useBilling hook, checkout success/cancel pages all implemented. Stripe webhook handlers handle checkout.session.completed + subscription lifecycle. Worker checkout + billing portal endpoints wired (b1f798a). 74 tests. **Remaining:** entitlement enforcement, plan change/downgrade flows.
- P7-TS-03: ✅ Stripe webhook signature verification works. Mock mode for tests.
- P7-TS-05: ⚠️ PARTIAL — SignetChainClient implemented with `bitcoinjs-lib` OP_RETURN (`ARKV` prefix). `getChainClient()` returns SignetChainClient when `ENABLE_PROD_NETWORK_ANCHORING=true`. **Remaining:** AWS KMS signing (mainnet), Signet node connectivity test, mainnet treasury funding.
- P7-TS-07: ✅ COMPLETE — PDF + JSON proof package downloads both wired. Fixed in CRIT-5 (commit a38b485).
- P7-TS-08: ✅ `generateAuditReport.ts` — full PDF certificate with jsPDF.
- P7-TS-09: ✅ COMPLETE — WebhookSettings.tsx with two-phase dialog (creation form → one-time secret display). Server-side secret generation via SECURITY DEFINER RPC (migration 0046). 34 tests (23 component + 11 integration).
- P7-TS-10: ✅ COMPLETE — Delivery engine with exponential backoff + HMAC signing. `anchor.ts` dispatches `anchor.secured` webhook after SECURED status set. Webhook retries scheduled in worker cron.
- P7-TS-11: ✅ COMPLETE — Signet treasury wallet utilities (`wallet.ts`: `generateSignetKeypair()`, `addressFromWif()`, `isValidSignetWif()`). CLI scripts (`generate-signet-keypair.ts`, `check-signet-balance.ts`). 13 tests.
- P7-TS-12: ✅ COMPLETE — UTXO provider pattern (`utxo-provider.ts`): `UtxoProvider` interface with `RpcUtxoProvider` (Bitcoin Core JSON-RPC) and `MempoolUtxoProvider` (Mempool.space REST API). Factory function `createUtxoProvider()`. Integrated into `SignetChainClient` + `getChainClient()`. 35 tests.
- P7-TS-13: ❌ NOT STARTED — Fingerprint indexing for efficient verification lookup. Currently O(n) UTXO scan in `verifyFingerprint()`.

### P4.5 Verification API — 0/13 NOT STARTED

All 13 stories behind `ENABLE_VERIFICATION_API=false`. Intentional — scheduled for post-launch.

### Orphaned Code (built but never wired)

| File | What It Does | Missing |
|------|-------------|---------|
| `src/components/embed/VerificationWidget.tsx` | Embeddable verification widget | Never imported. Needs route or standalone bundle. |

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

### Current: Remaining Production Blockers

| Task | Blocker | Detail |
|------|---------|--------|
| AWS KMS signing | CRIT-2 | Key provisioning for mainnet signing. SignetChainClient done, mainnet needs KMS. |
| Signet node connectivity test | CRIT-2 | Verify SignetChainClient against a real Signet node. |
| Mainnet treasury funding | CRIT-2 | Fund the production treasury wallet. |
| Entitlement enforcement | CRIT-3 | Gate features by subscription plan after checkout. |
| Plan change/downgrade | CRIT-3 | Handle subscription upgrades, downgrades, cancellations. |

### Pre-Launch (after blockers resolved)

| Task | Detail |
|------|--------|
| Supabase production | Provision production-tier project. |
| DNS + custom domain | `app.arkova.io` or equivalent. |
| Seed data strip | Remove demo users. |
| SOC 2 evidence | Begin collection (CI logs, RLS tests, audit events). |

### Do NOT Start

- P4.5 (Verification API) — defer to post-launch
- AI/OCR pipeline — Phase 2
- OpenTimestamps — decision made, direct OP_RETURN only

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
- API key UI: `src/components/ApiKeySettings.tsx` + `src/pages/ApiKeySettingsPage.tsx`
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
BITCOIN_NETWORK=                    # "signet", "testnet", or "mainnet"
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
```

---

_Directive version: 2026-03-11 (comprehensive audit update) | Repo: ArkovaCarson | 47 migrations | 594+ tests_
_Companion: MEMORY.md (living state) | Technical Backlog P1-P7 | Phase 1.5 Backlog | Business Backlog P1-P7_