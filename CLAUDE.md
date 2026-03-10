# ARKOVA — Claude Code Engineering Directive
## How to Use This Document

Paste the contents of this file into the **system prompt** of Claude Code, or save it as `CLAUDE.md` at the root of the `arkova-mvpcopy-main` repo. Claude Code will read it automatically before every task.

This directive tells Claude Code exactly how to operate on the Arkova codebase: what to read first, how to scope each task, what "done" means, and what it must never do.

---

## 0. READ THESE FILES FIRST — EVERY SESSION

Before making any change, read these files in order:

```
1. CLAUDE.md                                          ← demo credentials, repo overview
2. docs/confluence/01_architecture_overview.md        ← if it exists
3. The relevant agents.md in any folder you are about to edit
4. The story card from the Technical Backlog for the story you are implementing
```

If a folder you are editing contains an `agents.md` file, read it before touching anything. If you learn something important during your work, update that folder's `agents.md`.

---

## 1. THE CONSTITUTION — RULES THAT CANNOT BE BROKEN

These rules apply to every task. If a story conflicts with any rule below, the rule wins.

### Tech Stack (Locked)
- React + TypeScript + Tailwind CSS + shadcn/ui + Lucide React
- Supabase (Postgres + Auth)
- Zod for all validation
- Node.js worker in `services/worker/` for webhooks and anchoring
- **Never use Next.js API routes for long-running jobs**
- New AI libraries require explicit architecture review before introduction

### Schema-First (Non-Negotiable)
- Define DB schema + enums + constraints + RLS **before** building any UI that depends on them
- Once a table exists, **never use mock data or useState arrays** to represent that table's data
- Every schema change requires: migration file + rollback script + regenerated `database.types.ts` + updated seed data + updated Confluence page

### Terminology (UI Copy Only)
**Banned terms — never appear in any user-visible string:**
`Wallet` `Gas` `Hash` `Block` `Transaction` `Crypto` `Blockchain` `Bitcoin` `Testnet` `Mainnet` `UTXO` `Broadcast`

**Required replacements:**
| Banned | Use instead |
|--------|-------------|
| Wallet | Fee Account / Billing Account |
| Transaction | Network Receipt / Anchor Receipt |
| Hash | Fingerprint |
| Block | (omit or use "Network Record") |
| Testnet/Mainnet | Test Environment / Production Network |
| Broadcast | Publish Anchor |

All UI copy sourced from `src/lib/copy.ts`. CI must fail if banned terms appear in UI copy.

### Security (Mandatory)
- RLS on every table, always. `FORCE ROW LEVEL SECURITY` on all tables.
- No direct writes to privileged fields from client code
- SECURITY DEFINER functions must include `SET search_path = public`
- Never expose `supabase.auth.admin` or service role key to the browser
- Never hardcode secrets, API keys, or private keys anywhere
- Treasury/signing keys: server-side only, loaded from env vars, never logged
- Stripe webhook handlers must call `stripe.webhooks.constructEvent()` — no exceptions
- API keys must be hashed with HMAC-SHA256 using a server-side secret (`API_KEY_HMAC_SECRET`). Raw keys are never persisted after the initial creation response.
- API key lifecycle events (create, revoke) must be logged to `audit_events`.

### Testing
- RLS tests must use `src/tests/rls/helpers.ts` `withUser()` / `withAuth()` utilities — no ad-hoc auth mocking
- Tests must not call real Stripe or Bitcoin APIs — use `IPaymentProvider` and `IAnchorPublisher` interfaces
- Every task must keep the repo green: `typecheck`, `lint`, `tests` all pass before the task is complete

### Timestamps
- All server-side timestamps: Postgres `timestamptz`, treated as UTC
- Bitcoin timestamps displayed as **"Network Observed Time"** — never "Confirmed At" or "Finalized"
- Proof packages must state: what is measured, what is asserted, what is NOT asserted

### Client-Side Processing Boundary
- Arkova must not process document contents server-side
- File fingerprinting (`generateFingerprint`) runs in the browser only — never server-side
- `generateFingerprint` must never be imported or called in `services/worker/`

### API Versioning Policy
- The Verification API response schema is frozen once published. No field removals, type changes, or semantic changes without a new version prefix.
- Breaking changes require: v2+ URL prefix (e.g., `/api/v2/verify/:publicId`), 12-month deprecation notice on the previous version, and a documented migration guide published before the new version goes live.
- Additive changes (new optional response fields) are allowed without versioning, provided the new field is nullable or has a default, existing consumers are not required to handle it, and the change is documented in the OpenAPI spec changelog.
- The frozen schema must be defined as a single reusable OpenAPI component (`VerificationResult`) referenced by all verification endpoints. This is the single-source-of-truth for the response contract.

### Feature Flags
- API endpoints that are built but not yet launched must be gated behind an environment variable feature flag.
- `ENABLE_VERIFICATION_API` controls all `/api/v1/*` endpoints. When `false`, all gated endpoints return HTTP 503.
- Feature flags are boolean env vars, checked at middleware registration (not per-request). Changing the flag requires a worker restart.
- `/api/health` is always available regardless of feature flag state.

### Rate Limiting
- All public API endpoints must have rate limiting enforced.
- Anonymous callers: 100 req/min per IP.
- API key holders: 1,000 req/min per key (configurable per key in DB).
- Batch endpoints: 10 req/min per API key.
- Rate limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`) must be included on every API response.
- Exceeding rate limits returns HTTP 429 with `Retry-After` header.

---

## 2. HOW TO RECEIVE A TASK

Every task will be given to you in one of these formats:

**Format A — Story ID reference:**
> "Implement P2-TS-03"

When you receive a story ID, do the following before writing any code:
1. Locate the story card in the Technical Backlog (`Arkova_Technical_Backlog_P1_P7_March2026.docx`) or Phase 1.5 Backlog (`Arkova_Phase15_Technical_Backlog.docx`)
2. Read the full card: User Story, Acceptance Criteria, Dependencies, Tech Notes, DoD
3. Check the Audit Note — it tells you what already exists and what the specific gap is
4. Verify all dependencies are met before starting
5. Confirm the file path listed in the story card matches what exists in the repo
6. **State your plan** before writing any code: what you will change, what you will not touch, and what tests you will run

**Format B — Direct instruction:**
> "Fix the Stripe webhook signature verification"

When you receive a direct instruction:
1. Map it to the closest story ID in the Technical Backlog
2. Proceed as Format A from step 2

**Format C — Brand/UI task:**
> "Apply Arkova brand tokens to the app"

See Section 5 (Brand Application) for the exact procedure.

---

## 3. TASK EXECUTION RULES

### Before writing code
- [ ] Read the story card fully
- [ ] Confirm dependencies are met
- [ ] Read `agents.md` in any folder you will touch
- [ ] State your plan (files to change, files to leave alone, tests to run)

### While writing code
- [ ] One story at a time — do not fix unrelated things you notice
- [ ] If you find a bug outside your story scope, note it in `agents.md` and stop
- [ ] Every new Supabase table needs: migration + rollback + RLS + `database.types.ts` regenerated + seed update
- [ ] Every new hook follows the pattern of existing hooks (`useAuth.ts`, `useProfile.ts`)
- [ ] Every new component goes in `src/components/` — not inline in pages
- [ ] Validators go in `src/lib/validators.ts` — not defined inline in components
- [ ] All user-visible strings go through `src/lib/copy.ts` — not hardcoded in JSX

### After writing code
- [ ] Run: `npx tsc --noEmit` — zero type errors
- [ ] Run: `npm run lint` — zero lint errors
- [ ] Run: `npm test` — all tests pass
- [ ] Run: `npm run lint:copy` (if it exists) — no banned terminology in UI copy
- [ ] Run Playwright E2E suite — all specs pass
- [ ] Update seed data if schema changed — confirm click-through still works
- [ ] Update the relevant `docs/confluence/*.md` page
- [ ] Update `agents.md` in any folder you modified

### Definition of Done (a story is NOT done until all of these are true)
- [ ] All Acceptance Criteria in the story card are met
- [ ] Unit tests written and passing
- [ ] E2E / integration tests passing
- [ ] `typecheck`, `lint`, `tests` all green
- [ ] `lint:copy` passes (no banned terms)
- [ ] Code reviewed (self-review: read your own diff before declaring done)
- [ ] Seed data click-through still works
- [ ] Confluence documentation updated
- [ ] `agents.md` updated in modified folders
- [ ] No regressions in existing passing tests

---

## 4. STORY EXECUTION ORDER

Work stories in this order. Do not start a story until all of its dependencies are complete.

### Phase 0 — Unblocking (Do These First)

These three tasks unblock everything else. Nothing else is worth doing until they are done.

| Order | Story ID | Task | Why It Unblocks |
|-------|----------|------|-----------------|
| 1 | **P2-TS-03** | Install react-router-dom, refactor App.tsx from useState to BrowserRouter + Routes, define all named routes | ~15 components are invisible without this |
| 2 | **Brand** | Apply Arkova brand tokens to `src/index.css` and `tailwind.config.ts` | Single-file change, makes every screen correct immediately |
| 3 | **P1-TS-05** | Add `validateAnchorCreate()` call in `ConfirmAnchorModal.tsx` before the Supabase insert | 1-point fix, closes a security gap |

### Phase 1 — Complete PARTIAL Stories (P1–P3)

| Story ID | Task | Current Gap |
|----------|------|-------------|
| P2-TS-04 | Wire AuthGuard + RouteGuard into router | Guards exist but App.tsx doesn't use them |
| P3-TS-01 | Replace useState mock arrays in DashboardPage + VaultDashboard with real Supabase queries | Mock data, Math.random() fingerprints, console.log stubs |
| P3-TS-02 | Add `is_public_profile` migration, RLS policy, wire toggle to DB | Cosmetic toggle only |
| P3-TS-03 | Replace `href="#"` in Sidebar.tsx with `<Link>` components + active route highlighting | Dead links, no navigation |
| P4-TS-03 | Wire AssetDetailView to `/records/:id` route + real Supabase query | No route, generic chain proof data |

### Phase 2 — New Schema Work (P4-E2, highest unstarted priority)

| Story ID | Task | Dependency |
|----------|------|------------|
| P4-TS-04 | `credential_type` column migration | None |
| P4-TS-05 | `metadata` JSONB column + editability trigger | P4-TS-04 |
| P4-TS-06 | `parent_anchor_id` + `version_number` lineage columns | P4-TS-05 |

### Phase 3 — P5 Org Admin

| Story ID | Task |
|----------|------|
| P5-TS-01 | OrgRegistryTable: date range filter, bulk selection, fingerprint search |
| P5-TS-02 | RevokeDialog: add reason field + update `revoke_anchor` DB function |
| P5-TS-03 | Wire MembersTable to real Supabase query |
| P5-TS-05 | Move `public_id` generation to INSERT + build IssueCredentialForm |
| P5-TS-06 | BulkUploadWizard: add credential_type + metadata columns |
| P5-TS-07 | `credential_templates` migration + CRUD hook |

### Phase 4 — P6 Verification Portal

| Story ID | Task |
|----------|------|
| P6-TS-01 | Rebuild `get_public_anchor` RPC + PublicVerification.tsx to full 5-section spec |
| P6-TS-02 | Install qrcode.react + wire QR code into AssetDetailView |
| P6-TS-04 | `useCredentialLifecycle` hook + timeline display |
| P6-TS-05 | Install jsPDF + `generateAuditReport()` function |
| P6-TS-06 | `verification_events` analytics schema |
| P6-TS-03 | Embeddable widget bundle |

### Phase 5 — P7 Go-Live (Security-Critical First)

| Story ID | Task | Priority |
|----------|------|----------|
| P7-TS-03 | **Fix Stripe webhook signature verification** | SECURITY — do before connecting real Stripe |
| P7-TS-01 | Align billing schema with GTM pricing ($1K/$3K/custom) | |
| P7-TS-02 | Stripe checkout session endpoint in worker | |
| P7-TS-05 | **Replace MockChainClient with real Bitcoin OP_RETURN client** | PRODUCTION BLOCKER |
| P7-TS-07 | Wire JSON proof package download (ProofDownload.tsx) | |
| P7-TS-08 | PDF certificate generation | |
| P7-TS-09 | Wire WebhookSettings to router + fix secret hashing | |
| P7-TS-10 | Wire delivery engine to anchor lifecycle events | |

### Phase 6 — P4.5 Verification API

Build order matters. Stories are listed in dependency order. Do not start a story until its dependencies are complete.

**Architecture Decision (ADR-001 — RESOLVED):** record_uri format is `https://app.arkova.io/verify/{public_id}` (HTTPS URL). Do NOT use `arkova://rec/{public_id}`. The HTTPS format is universally resolvable by agents, browsers, and HTTP clients without custom protocol handlers.

| Order | Story ID | Task | Dependency |
|-------|----------|------|------------|
| 1 | P4.5-TS-12 | Feature flag middleware (`ENABLE_VERIFICATION_API`) | None |
| 2 | P4.5-TS-03 | API keys table, HMAC middleware, rate limiting | P1-TS-03 |
| 3 | P4.5-TS-01 | GET /api/v1/verify/:publicId (frozen schema) | P6-TS-01, P4.5-TS-03, ADR-001 |
| 4 | P4.5-TS-06 | GET /api/v1/jobs/:jobId (async job polling) | P4.5-TS-03 |
| 5 | P4.5-TS-02 | POST /api/v1/verify/batch | P4.5-TS-01, P4.5-TS-06 |
| 6 | P4.5-TS-07 | GET/POST/DELETE /api/v1/keys (key CRUD endpoints) | P4.5-TS-03 |
| 7 | P4.5-TS-05 | Free tier entitlement enforcement (10K/month) | P4.5-TS-03 |
| 8 | P4.5-TS-08 | GET /api/v1/usage | P4.5-TS-05 |
| 9 | P4.5-TS-04 | OpenAPI 3.0 documentation (/api/docs) | All endpoints above |
| 10 | P4.5-TS-09 | API Key Management UI (/settings/api-keys) | P4.5-TS-07, P2-TS-03, P2-TS-04 |
| 11 | P4.5-TS-10 | API Usage Dashboard Widget | P4.5-TS-05, P3-TS-01 |
| 12 | P4.5-TS-11 | API Key Scope Display + Read-Write Guard (UI) | P4.5-TS-09, P4.5-TS-07 |
| 13 | P4.5-TS-13 | Rate limit load test suite (operational) | All endpoints deployed |

**Phase 1.5 frozen response schema (reference for all verify endpoint stories):**

{ "verified": boolean, "status": "ACTIVE" | "REVOKED" | "SUPERSEDED" | "EXPIRED", "issuer_name": string, "recipient_identifier": string, "credential_type": string, "issued_date": string | null, "expiry_date": string | null, "anchor_timestamp": string, "bitcoin_block": number | null, "network_receipt_id": string | null, "merkle_proof_hash": string | null, "record_uri": "https://app.arkova.io/verify/{public_id}", "jurisdiction": string | null }

Notes: recipient_identifier is always hashed (never raw PII). jurisdiction key is omitted entirely when null (not returned as null). Breaking changes require v2+ endpoint prefix with >= 12-month deprecation notice.

**Phase 1.5 file placement (extends Constitution Section 11):**
- API route handlers: `services/worker/src/api/`
- API middleware: `services/worker/src/middleware/`
- API Zod schemas: `services/worker/src/schemas/`
- API key management UI: `src/components/ApiKeySettings.tsx`, `src/pages/ApiKeySettingsPage.tsx`
- API usage widget: `src/components/ApiUsageWidget.tsx`
- Load tests: `tests/load/`

**Phase 1.5 Constitution compliance reminders:**
- All API endpoints run in `services/worker/` — never Next.js API routes
- API returns only derived metadata and fingerprints — no document content (Rule 4A)
- `recipient_identifier` is always hashed — no raw PII in API responses (Rule 4)
- API key secrets hashed with HMAC-SHA256 — raw key never persisted (Rule 4)
- UI copy for API key pages goes through `src/lib/copy.ts` (Rule 3)
- All new tables require RLS + `FORCE ROW LEVEL SECURITY` + migration + rollback (Rule 2)
- Feature flag `ENABLE_VERIFICATION_API` must be `false` until launch criteria are met

---

## 5. BRAND APPLICATION PROCEDURE

The codebase currently uses generic shadcn blue (`#3b82f6`) as primary. The correct Arkova brand color is Steel Blue (`#82b8d0`). This is a single-file fix that corrects every screen simultaneously.

### Step 1 — Replace `src/index.css` `:root` block

Replace the entire `:root { ... }` and `.dark { ... }` blocks in `src/index.css` with the following:

```css
:root {
  --background: 0 0% 100%;
  --foreground: 156 4% 19%;

  --card: 0 0% 100%;
  --card-foreground: 156 4% 19%;

  --popover: 0 0% 100%;
  --popover-foreground: 156 4% 19%;

  --primary: 197 42% 66%;
  --primary-foreground: 0 0% 100%;

  --secondary: 199 44% 90%;
  --secondary-foreground: 156 4% 19%;

  --muted: 199 30% 95%;
  --muted-foreground: 160 4% 35%;

  --accent: 200 40% 53%;
  --accent-foreground: 0 0% 100%;

  --destructive: 0 84% 60%;
  --destructive-foreground: 0 0% 100%;

  --success: 160 84% 39%;
  --success-foreground: 0 0% 100%;

  --warning: 38 92% 50%;
  --warning-foreground: 30 80% 15%;

  --border: 199 20% 88%;
  --input: 199 20% 88%;
  --ring: 197 42% 66%;

  --radius: 0.5rem;

  --sidebar-background: 156 4% 19%;
  --sidebar-foreground: 199 30% 85%;
  --sidebar-primary: 197 42% 66%;
  --sidebar-primary-foreground: 0 0% 100%;
  --sidebar-accent: 156 4% 25%;
  --sidebar-accent-foreground: 199 30% 90%;
  --sidebar-border: 156 4% 25%;
  --sidebar-ring: 197 42% 66%;
}

.dark {
  --background: 156 4% 10%;
  --foreground: 199 30% 90%;

  --card: 156 4% 12%;
  --card-foreground: 199 30% 90%;

  --popover: 156 4% 12%;
  --popover-foreground: 199 30% 90%;

  --primary: 197 42% 66%;
  --primary-foreground: 156 4% 10%;

  --secondary: 156 4% 18%;
  --secondary-foreground: 199 30% 90%;

  --muted: 156 4% 18%;
  --muted-foreground: 199 20% 55%;

  --accent: 200 40% 53%;
  --accent-foreground: 0 0% 100%;

  --destructive: 0 63% 31%;
  --destructive-foreground: 0 0% 100%;

  --success: 160 70% 45%;
  --success-foreground: 160 80% 10%;

  --warning: 48 97% 53%;
  --warning-foreground: 30 80% 15%;

  --border: 156 4% 20%;
  --input: 156 4% 20%;
  --ring: 197 42% 55%;

  --sidebar-background: 156 4% 8%;
  --sidebar-foreground: 199 30% 85%;
  --sidebar-primary: 197 42% 66%;
  --sidebar-primary-foreground: 0 0% 100%;
  --sidebar-accent: 156 4% 15%;
  --sidebar-accent-foreground: 199 30% 90%;
  --sidebar-border: 156 4% 15%;
  --sidebar-ring: 197 42% 66%;
}
```

### Step 2 — Add Arkova brand colors to `tailwind.config.ts`

Add to `theme.extend.colors`:

```ts
arkova: {
  steel:         '#82b8d0',
  'steel-light': '#a8d1e2',
  'steel-dark':  '#3d8aad',
  deep:          '#5496ba',
  ocean:         '#2f7495',
  charcoal:      '#303433',
  ice:           '#dbeaf1',
  frost:         '#edf5f9',
  slate:         '#4a4f4e',
  mist:          '#f4f8fa',
},
```

### Step 3 — Verify

After applying:
- Run the app locally — sidebar should be charcoal (`#303433`), primary buttons should be Steel Blue (`#82b8d0`)
- Check `src/index.css` for any remaining `#3b82f6` — replace with `hsl(var(--primary))`
- Run `npm run lint` — no errors

### Brand Rules for New Components
- Sidebar background: always `bg-arkova-charcoal` or `bg-sidebar-background`
- Primary buttons: `bg-primary` (resolves to Steel Blue)
- Status badges: SECURED=green (`#059669`), PENDING=amber (`#d97706`), REVOKED=gray (`#6b7280`), EXPIRED=gray
- Fingerprint/hash display: always `font-mono text-xs bg-muted rounded px-2 py-1`
- Public verification page status badge: large pill, full-width on mobile, color-coded
- Logo on dark backgrounds (sidebar): white wordmark + light blue bear
- Logo on white: full-color as-is

---

## 6. DOCUMENTATION UPDATE PROCEDURE

Every story that changes schema, security posture, or API contracts must update documentation in the same commit. This is not optional.

### Confluence Pages (Markdown files in `docs/confluence/`)

| What changed | Page to update |
|-------------|----------------|
| Any schema change | `02_data_model.md` |
| RLS policy change | `03_security_rls.md` |
| Audit events change | `04_audit_events.md` |
| Legal hold / retention | `05_retention_legal_hold.md` |
| Bitcoin / chain policy | `06_on_chain_policy.md` |
| Seed data / click-through | `07_seed_clickthrough.md` |
| Billing or entitlements (P7+) | `08_payments_entitlements.md` |
| Webhooks (P7+) | `09_webhooks.md` |
| Anchoring worker (P7+) | `10_anchoring_worker.md` |
| Proof packages (P7+) | `11_proof_packages.md` |
| Verification API (P4.5+) | `12_verification_api.md` |

If a page does not exist yet, create it. Use this template:

```markdown
# [Page Title]
_Last updated: [date] | Story: [story ID]_

## Overview
[1-2 sentence summary of what this covers]

## Current State
[What is implemented as of this update]

## Schema / Contract
[Tables, columns, functions, or API contracts relevant to this page]

## Security Notes
[RLS policies, SECURITY DEFINER functions, access control decisions]

## Change Log
| Date | Story | Change |
|------|-------|--------|
| [date] | [story ID] | [what changed] |
```

### agents.md Updates

After modifying any folder, update or create `agents.md` in that folder:

```markdown
# agents.md — [folder name]
_Last updated: [date]_

## What This Folder Contains
[Brief description]

## Recent Changes
- [date] [story ID]: [what changed and why]

## Do / Don't Rules
- DO: [important pattern to follow]
- DON'T: [thing that looks reasonable but breaks something]

## Dependencies
- [other files or services this folder depends on]
```

---

## 7. MIGRATION PROCEDURE

Every database migration must follow this exact procedure:

```bash
# 1. Create migration file
# File naming: supabase/migrations/NNNN_descriptive_name.sql
# Use next sequential number

# 2. Write the migration
# Include at the bottom of every migration file:
-- ROLLBACK:
-- [compensating SQL to undo this migration]

# 3. Apply locally
npx supabase db push

# 4. Regenerate types
npx supabase gen types typescript --local > src/types/database.types.ts

# 5. Update seed data
# Edit supabase/seed.sql to work with new schema

# 6. Verify click-through
npx supabase db reset   # applies migrations + seed
# Manually verify the app click-through still works

# 7. Update Confluence
# Edit docs/confluence/02_data_model.md
```

**Never modify an existing migration file.** Write a new compensating migration instead.

---

## 8. TESTING REQUIREMENTS

### RLS Tests
```typescript
// Always use the shared helper — never mock auth ad-hoc
import { withUser, withAuth } from '../tests/rls/helpers';

it('blocks cross-tenant access', async () => {
  await withUser(userFromOrgA, async (client) => {
    const { data } = await client.from('anchors').select();
    expect(data).toEqual([]); // OrgB records not returned
  });
});
```

### Worker Tests (Stripe / Bitcoin)
```typescript
// Always inject interfaces — never call real APIs
const mockPayment: IPaymentProvider = { createCheckout: jest.fn(), ... };
const mockChain: IAnchorPublisher = { publishAnchor: jest.fn().mockResolvedValue({ txId: 'mock_tx' }) };
```

### Gherkin → Test Mapping
Each story card contains Gherkin scenarios. Map them directly to tests:
- `Given` → test setup / `beforeEach`
- `When` → the action being tested
- `Then` / `And` → `expect()` assertions

---

## 9. COMMON MISTAKES — DO NOT DO THESE

| Mistake | Why It's Wrong | What To Do Instead |
|---------|---------------|-------------------|
| Using `useState` to store records from a Supabase table | Violates schema-first rule, shows stale data | Create a `useXxx()` hook that queries Supabase |
| Calling `supabase.from('anchors').insert()` without `validateAnchorCreate()` | Skips client-side validation, allows forbidden fields | Always call the Zod validator first |
| Writing a SECURITY DEFINER function without `SET search_path = public` | Security vulnerability — search path injection | Always add `SET search_path = public` |
| Adding user-visible text directly to JSX | Terminology drift, no copy lint coverage | Add the string to `src/lib/copy.ts` first |
| Adding a new table without regenerating `database.types.ts` | TypeScript types out of sync | Run `supabase gen types typescript --local` after every migration |
| Calling real Stripe or Bitcoin APIs in tests | CI breaks without credentials, flaky tests | Use `IPaymentProvider` and `IAnchorPublisher` mocks |
| Setting `anchor.status = 'SECURED'` from client code | Constitution violation — only worker via service_role can do this | Trigger the anchoring worker; let it set SECURED via `complete_anchoring_job()` |
| Exposing `user_id`, `org_id`, or `anchors.id` on the public verification page | Privacy violation | Expose only `public_id` and derived display fields |
| Adding a nav link with `href="#"` | Dead link, breaks navigation | Use `<Link to="/path">` from react-router-dom |
| Storing a raw Stripe webhook secret or Bitcoin private key in code | Security critical | Load from environment variable only, never log it |
| Returning `jurisdiction: null` in verify API response | Frozen schema says omit the key when null | Use conditional spread: `...(jurisdiction && { jurisdiction })` |
| Persisting raw API key in `api_keys` table | Security violation — raw key exposure | Hash with HMAC-SHA256 using `API_KEY_HMAC_SECRET` before INSERT |
| Importing `generateFingerprint` in `services/worker/src/api/` | Constitution violation — fingerprinting is client-side only | Worker API returns pre-computed fingerprints from DB, never computes them |
| Using `arkova://rec/` as record_uri format | ADR-001 resolved: use HTTPS | Use `https://app.arkova.io/verify/{public_id}` |
| Exposing API endpoints without checking `ENABLE_VERIFICATION_API` | Premature API exposure before launch criteria met | All `/api/v1/*` routes must pass through `featureFlag.ts` middleware |

---

## 10. ENVIRONMENT VARIABLES REFERENCE

Never commit these. Load from `.env` (gitignored). The worker reads them at startup and fails loudly if missing.

```bash
# Supabase
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=        # worker only — never in browser

# Stripe (worker only)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

# Bitcoin (worker only)
BITCOIN_TREASURY_WIF=             # treasury signing key — never logged
BITCOIN_NETWORK=                  # "mainnet" or "testnet" (displayed as "Production Network" / "Test Environment")

# Worker
WORKER_PORT=3001

# Verification API (worker only — Phase 1.5)
ENABLE_VERIFICATION_API=false       # Feature flag: set to true only when ALL launch criteria are met
API_KEY_HMAC_SECRET=                # HMAC-SHA256 secret for API key hashing — never logged, rotatable
CORS_ALLOWED_ORIGINS=*              # Comma-separated allowed origins for verification API CORS
```

---

## 11. QUICK REFERENCE — STORY STATUS AT MARCH 2026

| Priority | Complete | Partial | Not Started |
|----------|----------|---------|-------------|
| P1 Bedrock | 6/6 | 0 | 0 |
| P2 Identity | 5/5 (router, guards, hooks, profile page, org settings) | 0 | 0 |
| P3 Vault | 3/3 (data wiring, privacy toggle, nav links) | 0 | 0 |
| P4-E1 Anchor Engine | 3/3 (creation flow, record detail, lifecycle UI) | 0 | 0 |
| P4-E2 Credential Metadata | 3/3 (credential_type, metadata JSONB, lineage) | 0 | 0 |
| P5 Org Admin | 5/6 (registry, revoke, members, public_id, bulk upload) | 1/6 (P5-TS-07 credential templates — migration exists, CRUD hook pending) | 0 |
| P6 Verification | 2/6 (P6-TS-01 public anchor RPC + UI, P6-TS-02 QR code) | 0 | 4/6 (P6-TS-03 widget, P6-TS-04 lifecycle hook, P6-TS-05 jsPDF, P6-TS-06 analytics) |
| P7 Go-Live | 0/8 | 4/8 (billing schema, proof download, webhooks settings, delivery engine) | 4/8 |
| P4.5 Verification API | 0/13 | 0/13 | 13/13 |
| **Total** | **27/53** | **5/53** | **21/53** |

**Overall: 51% complete. 9% partial. 40% not started.**

_Audited against codebase on 2026-03-10. Major sprint 2026-03-09 to 2026-03-10 completed 15 stories across 6 PRs. Key changes:_
- _P1-TS-06 audit event logging completed_
- _P2-TS-05 (identity section) and P2-TS-06 (org settings page) completed_
- _P3-TS-03 nav links wired with react-router-dom_
- _P4-E2 all 3 stories completed (credential_type, metadata JSONB, lineage columns)_
- _P5-TS-01 (registry filters), P5-TS-02 (revoke reason), P5-TS-05 (public_id on insert), P5-TS-06 (bulk upload metadata) completed_
- _P6-TS-01 rebuilt get_public_anchor RPC with Phase 1.5 frozen schema (14 fields, status mapping SECURED→ACTIVE)_
- _P6-TS-02 QR code verification link in AssetDetailView_
- _Race condition fix in get_public_anchor second SELECT (status filter added)_
- _useProfile/useOrganization hooks now return boolean from update methods for proper UI feedback_
- _Migration numbering: 42 migration files, versions 0001–0043 (0033 intentionally skipped, 0039 used by rebuild_get_public_anchor)_

The remaining 5 partial stories need targeted fixes (CRUD hooks, download handlers). The 13 Phase 1.5 API stories are all new and should be built during Phase I weeks 6-7 behind the `ENABLE_VERIFICATION_API` feature flag.

Phase 1.5 stories added: P4.5-TS-06 (async job polling), P4.5-TS-07 (key CRUD endpoints), P4.5-TS-08 (usage endpoint), P4.5-TS-09 (API key management UI), P4.5-TS-10 (usage dashboard widget), P4.5-TS-11 (key scope UI), P4.5-TS-12 (feature flag), P4.5-TS-13 (load test suite). Full story cards in Arkova_Phase15_Technical_Backlog.docx.

---

_Document version: March 2026 (2026-03-10 sprint update) | Repo: arkova-mvpcopy-main | ~18,700 source lines | 42 migrations_
_Companion documents: Arkova Technical Backlog P1-P7 March 2026 | Arkova Phase 1.5 Technical Backlog March 2026 | Arkova Business Backlog P1-P7 March 2026_
