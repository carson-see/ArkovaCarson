# User Flow Gap Stories

_Last updated: 2026-03-15 (All UF stories COMPLETE — Sprints A/B/C, PRs #60/#61/#62)_

## Group Overview

These stories address **critical user flow gaps** identified 2026-03-16. The current system is 100% issuer-centric — credentials can be created and anchored, but the end-to-end experience for viewing, discovering, and receiving credentials is broken. These gaps must be resolved **before P4.5 Verification API work begins**.

**Priority:** CRITICAL — these complete the core credentialing loop that makes the product usable.

**Architecture context:** Credential templates are **display templates** that reconstruct a visual representation of a credential from stored metadata. Documents are never stored (Constitution 1.6). The template + metadata allows Arkova to render what a credential looks like without having the original document.

### Completion Summary

| Status | Count |
|--------|-------|
| COMPLETE | 10 |
| PARTIAL | 0 |
| NOT STARTED | 0 |

---

## UF-01: Template-Based Credential Rendering

**Status:** COMPLETE
**Priority:** CRITICAL (core product gap)
**Depends on:** P5-TS-07 (credential_templates table — COMPLETE)
**Completed:** 2026-03-16 (Sprint A)

### Problem

Credential templates exist as CRUD data only. They are created and managed in `CredentialTemplatesManager`, but **never used to render credentials**. When viewing a credential on the public verification page, asset detail view, or org registry, the display is a hardcoded 5-section layout that ignores the template entirely. The `default_metadata` field in `credential_templates` is stored but never applied.

This is the foundational gap — templates are the mechanism by which Arkova shows records without storing documents (Constitution 1.6). Without template rendering, the product cannot visually represent credentials.

### What It Delivers

A `CredentialRenderer` component that takes a credential's `credential_type` + `metadata` + the corresponding template's `default_metadata` schema and renders a branded, structured visual representation of the credential. This component replaces the hardcoded sections in PublicVerification and AssetDetailView.

### Acceptance Criteria

- [x] New `CredentialRenderer` component that renders a credential using its template
- [x] Renderer reads `credential_type` from the anchor, looks up the matching `credential_template` for that org
- [x] Template `default_metadata` defines the field schema (field names, types, display order)
- [x] Anchor `metadata` provides the actual values for those fields
- [x] Renderer produces a card-style visual: org logo/name header, credential title, field grid (label: value pairs), dates, status badge
- [x] Dates formatted as human-readable (not ISO timestamps)
- [x] Empty/null fields hidden (not shown as "null" or empty rows)
- [x] Fallback rendering when no template exists: show metadata as labeled key-value pairs
- [x] Fallback rendering when no metadata exists: show filename + fingerprint + status only
- [x] `CredentialRenderer` used in: PublicVerification.tsx (Section 1 replacement), AssetDetailView.tsx (detail panel), OrgRegistryTable.tsx (expandable row or modal)
- [x] Follows Nordic Vault design system: `glass-card`, `font-mono` for fingerprints, `shadow-card-rest`/`shadow-card-hover`, `animate-in-view`
- [x] No template data exposed that shouldn't be public (template is org-internal config; only the rendered output is shown)
- [x] Tests: unit tests for renderer with various metadata shapes, missing fields, no template, no metadata (20 tests)

### Schema Notes

**Existing tables (no migration needed):**
- `credential_templates`: `id`, `org_id`, `name`, `description`, `credential_type`, `default_metadata` (JSONB), `is_active`
- `anchors`: `credential_type`, `metadata` (JSONB), `org_id`, `public_id`, `status`

**Template `default_metadata` schema convention** (to be documented, not enforced in DB):
```json
{
  "fields": [
    { "key": "institution", "label": "Institution", "type": "text" },
    { "key": "degree", "label": "Degree", "type": "text" },
    { "key": "graduation_date", "label": "Graduation Date", "type": "date" },
    { "key": "gpa", "label": "GPA", "type": "number" }
  ]
}
```

Anchor `metadata` then stores actual values:
```json
{
  "institution": "University of Michigan",
  "degree": "Bachelor of Science",
  "graduation_date": "2025-05-15",
  "gpa": 3.8
}
```

### Files

- New: `src/components/credentials/CredentialRenderer.tsx` — core rendering component (3 modes: template+metadata, metadata-only, filename-only)
- New: `src/components/credentials/CredentialRenderer.test.tsx` — 20 unit tests
- New: `src/hooks/useCredentialTemplate.ts` — hook for template fetch (authenticated + public RPC modes)
- New: `supabase/migrations/0054_public_template_and_pending_anchor.sql` — `get_public_template` RPC + updated `get_public_anchor` for PENDING
- Edit: `src/components/verification/PublicVerification.tsx` — integrated CredentialRenderer + PENDING state
- Edit: `src/components/anchor/AssetDetailView.tsx` — added CredentialRenderer card
- Edit: `src/components/credentials/index.ts` — barrel export

### Technical Notes

- Template lookup: `credential_templates` WHERE `org_id` = anchor's `org_id` AND `credential_type` = anchor's `credential_type` AND `is_active` = true
- Public verification uses `get_public_template(p_credential_type, p_org_id)` SECURITY DEFINER RPC — returns only `name` + `default_metadata`, no internal org data
- `useCredentialTemplate` hook supports two modes: authenticated (direct Supabase query) and public (RPC via `get_public_template`)
- `parseTemplateFields()` exported for parsing JSON `default_metadata.fields` into typed `TemplateField[]`

---

## UF-02: Public Credential Discovery + Search

**Status:** COMPLETE
**Priority:** HIGH (discoverability gap)
**Depends on:** P5-TS-05 (public_id — COMPLETE), P2-TS-05 (is_public_profile — COMPLETE)
**Completed:** 2026-03-16 (Sprint B, PR #61)

### Problem

There is no way to find credentials without already knowing the `publicId` or having the original file. The only entry points are:
1. Direct URL: `/verify/{publicId}` (requires the link)
2. File-based: drag file onto `/verify` page (requires the original document)

This means credentials are invisible unless shared by the issuer. There is no search, no directory, no way for a third party (employer, university, verifier) to discover credentials.

### What It Delivers

A public search interface at `/search` that allows:
1. **Search by public ID** — already works via `/verify/:publicId`, but search page provides a unified entry point
2. **Search by issuer name** — if the issuer's profile is public (`is_public_profile = true`), their org name is searchable and shows their public credential registry
3. **Search by recipient name/identifier** — if the credential metadata contains a recipient field and the anchor is public

### Acceptance Criteria

- [x] New `/search` public route (no auth required)
- [x] Search form with: text input, search type selector (ID / Issuer / Recipient)
- [x] **By ID:** redirect to `/verify/{publicId}` on match, "not found" on miss
- [x] **By Issuer:** full-text search on `organizations.name` WHERE profile is public → shows org card with credential count + link to issuer's public registry
- [x] **By Recipient (future):** search `anchors.metadata->>'recipient_name'` for public anchors — Phase 2 enhancement, show as "coming soon" in UI
- [x] New `search_public_issuers(p_query text)` SECURITY DEFINER RPC: returns org `id`, `name`, count of public anchors, only for orgs where `profiles.is_public_profile = true`
- [x] Issuer result card links to `/issuer/{orgId}` (new route) showing that org's public credential registry
- [x] New `/issuer/:orgId` public route showing: org name, description, list of public SECURED anchors with credential type + issued date + verify link
- [x] New `get_public_issuer_registry(p_org_id uuid)` SECURITY DEFINER RPC: returns org info + list of public anchors (public_id, credential_type, filename, issued_at, status) — only SECURED status, only for public-profile orgs
- [x] Search results paginated (20 per page)
- [x] Empty states: "No issuers found", "No credentials found"
- [x] Follows Nordic Vault design: `bg-mesh-gradient` background, `glass-card` result cards, `animate-in-view` stagger
- [x] No internal IDs exposed (only `public_id` and org names)
- [x] Rate limited: anonymous search capped at 30 req/min per IP

### Schema Notes

**Existing tables (may need migration):**
- `organizations`: `id`, `name` — no `is_public` flag (this is on `profiles.is_public_profile`)
- `anchors`: `public_id`, `org_id`, `status`, `credential_type`, `metadata`, `filename`, `issued_at`
- `profiles`: `is_public_profile` (boolean, migration 0014)

**New migration needed:**
- `search_public_issuers(p_query text)` RPC — SECURITY DEFINER, searches orgs by name where the org has at least one admin with `is_public_profile = true`
- `get_public_issuer_registry(p_org_id uuid)` RPC — SECURITY DEFINER, returns public anchors for an org
- Consider GIN index on `organizations.name` for full-text search performance

### Files

- New: `src/pages/SearchPage.tsx` — public search page
- New: `src/pages/IssuerRegistryPage.tsx` — public issuer credential registry
- New: `src/components/search/SearchForm.tsx` — search input with type selector
- New: `src/components/search/IssuerCard.tsx` — result card for issuer search
- New: `src/components/search/CredentialCard.tsx` — result card for credential in issuer registry
- New: `src/hooks/usePublicSearch.ts` — hook for search RPCs
- Edit: `src/App.tsx` — add `/search` and `/issuer/:orgId` public routes
- Edit: `src/lib/routes.ts` — add SEARCH and ISSUER_REGISTRY route constants
- Edit: `src/lib/copy.ts` — search page copy
- New migration: `supabase/migrations/0055_public_search.sql`

---

## UF-03: Individual Recipient Credential Inbox

**Status:** COMPLETE
**Priority:** HIGH (recipient experience gap)
**Depends on:** UF-01 (template rendering), UF-02 (public discovery — partial)
**Completed:** 2026-03-15 (Sprint C, PR #62)

### Problem

The system is 100% issuer-centric. When an org issues a credential to an individual, that individual has **no way to see it** unless the issuer manually sends them a verification link. There is no:
- "Credentials issued to me" inbox
- Way to claim a credential issued to your identity
- Notification when a new credential is issued to you
- Recipient dashboard showing all received credentials

The `anchors` table has no `recipient_id` or `recipient_email` field. Recipient info may exist in `metadata` JSONB but is unstructured and unsearchable.

### What It Delivers

A structured recipient tracking system that lets individuals see credentials issued to them, with a "My Credentials" inbox in their dashboard.

### Acceptance Criteria

**Phase 1 (MVP — this story):**
- [x] New `anchor_recipients` table: `id`, `anchor_id` (FK), `recipient_email_hash` (text, SHA-256 hashed for privacy), `recipient_user_id` (nullable FK to profiles), `claimed_at` (nullable timestamp), `created_at`
- [x] When org issues a credential, they can specify a recipient email in `IssueCredentialForm`
- [x] `anchor_recipients` row created on anchor insert (recipient_email stored as SHA-256 hash via `hashEmail()`, not plaintext)
- [x] If recipient email matches an existing Arkova user, `recipient_user_id` is auto-linked
- [x] New `/my-credentials` authenticated route showing all credentials where `recipient_user_id = auth.uid()`
- [x] `MyCredentialsPage` displays: credential card (using `CredentialRenderer` from UF-01), issuer name, issued date, status, verify link
- [x] "Claim" flow: `link_credentials_on_signup` trigger auto-links unclaimed credentials on signup
- [x] Individual dashboard shows "My Credentials" nav item in sidebar
- [x] RLS: users can only see `anchor_recipients` rows where `recipient_user_id = auth.uid()`
- [x] Recipient email never exposed in public verification (privacy)
- [x] Tests: useMyCredentials hook tests, hashEmail tests

**Phase 2 (deferred):**
- [ ] Email notification when a new credential is issued to your address
- [ ] "Share to LinkedIn" from My Credentials page
- [ ] Credential portfolio: curated public page of your credentials

### Schema Notes

**New migration:**
```sql
CREATE TABLE anchor_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_id uuid NOT NULL REFERENCES anchors(id) ON DELETE CASCADE,
  recipient_email_hash text NOT NULL,  -- HMAC-SHA256 hash
  recipient_user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT anchor_recipients_unique UNIQUE (anchor_id, recipient_email_hash)
);

-- RLS: recipients see only their own rows
-- Service role: worker can insert/update for linking
```

**Recipient linking logic (worker or RPC):**
1. On anchor creation with recipient email: hash email, insert into `anchor_recipients`
2. On user signup: check `anchor_recipients` for matching email hash, set `recipient_user_id`
3. On `/my-credentials` load: query `anchor_recipients` WHERE `recipient_user_id = auth.uid()` JOIN `anchors`

### Files

- New migration: `supabase/migrations/0056_anchor_recipients.sql` — table, RLS, `get_my_credentials` RPC, `link_credentials_on_signup` trigger
- New: `src/pages/MyCredentialsPage.tsx` — recipient inbox page
- New: `src/hooks/useMyCredentials.ts` — hook wrapping `get_my_credentials` RPC
- New: `src/hooks/useMyCredentials.test.ts` — 4 tests
- New: `src/lib/fileHasher.test.ts` — 5 hashEmail tests
- Edit: `src/lib/fileHasher.ts` — added `hashEmail()` utility (SHA-256, client-side)
- Edit: `src/components/organization/IssueCredentialForm.tsx` — recipient email → `anchor_recipients` insert with hashed email
- Edit: `src/App.tsx` — add `/my-credentials` route
- Edit: `src/lib/routes.ts` — add MY_CREDENTIALS route constant
- Edit: `src/lib/copy.ts` — credential inbox copy
- Edit: `src/components/layout/Sidebar.tsx` — add "My Credentials" nav item
- Edit: `src/types/database.types.ts` — added `anchor_recipients` table + `get_my_credentials` function types

---

## UF-04: Anchor Status Lifecycle UX (PENDING → SECURED)

**Status:** COMPLETE
**Priority:** CRITICAL (user confusion)
**Depends on:** None
**Completed:** 2026-03-16 (Sprint A)

### Problem

When a user creates an anchor (individual or org), they see a success message within seconds. But the anchor is PENDING — the worker must process it and broadcast to Bitcoin before it becomes SECURED. Users think their credential is live immediately. Worse, public verification hides PENDING anchors entirely, so a verifier clicking the link right after issuance sees "No Record Found."

### What It Delivers

Clear status communication throughout the anchor lifecycle:
1. **Post-creation messaging** — success screen says "Your document has been submitted for anchoring. This typically takes 5-15 minutes." with a progress indicator
2. **PENDING state visibility** — dashboard and record list show PENDING anchors with "Processing since X minutes ago" indicator, animated shimmer or spinner on the status badge
3. **Public verification of PENDING** — show "Record Found — Anchoring In Progress" instead of hiding PENDING anchors. Display issuer, credential type, and created date, but clearly state the Bitcoin anchor is not yet confirmed
4. **Transition notification** — when anchor moves PENDING → SECURED, show toast on next page load or real-time via Supabase realtime subscription
5. **Share link available immediately** — show public verification URL on success screen even for PENDING anchors, with note that verifiers will see "in progress" status

### Acceptance Criteria

- [x] SecureDocumentDialog success screen: shows public_id, verification URL, "Anchoring in progress — typically 5-15 minutes" message, copy-link button
- [x] IssueCredentialForm success: same — shows public_id + verification URL + processing message + "Issue Another" button
- [ ] DashboardPage: PENDING anchors show animated status badge with "Processing since X min" tooltip (deferred — low priority)
- [x] RecordsList/OrgRegistryTable: PENDING rows have distinct visual treatment (pulsing amber badge)
- [x] PublicVerification.tsx: query includes PENDING status. PENDING anchors render with "Anchoring In Progress" banner, show available info (issuer, type, created date), hide Bitcoin-specific fields (chain_tx_id, block height)
- [ ] VerificationForm.tsx (file-based): same — find PENDING anchors, show "in progress" state (deferred — relies on fingerprint match returning PENDING)
- [ ] Optional: Supabase realtime subscription on anchor status changes for live updates (deferred — Sprint C)
- [x] Tests: PENDING anchor displays correctly in public verification (covered by existing + new tests)

### Files

- Edit: `src/components/anchor/SecureDocumentDialog.tsx` — enhanced success screen
- Edit: `src/components/organization/IssueCredentialForm.tsx` — enhanced success
- Edit: `src/components/verification/PublicVerification.tsx` — include PENDING in query, add "in progress" banner
- Edit: `src/components/verify/VerificationForm.tsx` — same
- Edit: `src/pages/DashboardPage.tsx` — PENDING visual treatment
- Edit: `src/components/organization/OrgRegistryTable.tsx` — PENDING visual treatment
- Edit: `src/lib/copy.ts` — anchoring status messages

---

## UF-05: Credential Metadata Entry in Issuance Forms

**Status:** COMPLETE
**Priority:** HIGH (data quality gap)
**Depends on:** UF-01 (template rendering — uses same field schema)
**Completed:** 2026-03-16 (Sprint B, PR #61)

### Problem

When an org issues a credential, `IssueCredentialForm` collects only: file, credential_type, label, issuedAt. The `metadata` JSONB field exists in the schema but is **never populated through the UI**. This means:
- Credentials have no structured data (institution name, degree, student ID, etc.)
- Template rendering (UF-01) has nothing to render — metadata is empty
- Public verification shows only filename + fingerprint, which is meaningless to verifiers

### What It Delivers

Dynamic metadata form fields driven by the credential template's `default_metadata` schema. When admin selects a credential type, the form loads the corresponding template's field definitions and renders input fields for each.

### Acceptance Criteria

- [x] `IssueCredentialForm`: when user selects `credential_type`, fetch matching template from `credential_templates`
- [x] Render dynamic form fields based on template's `default_metadata.fields` array
- [x] Supported field types: `text` (input), `date` (date picker), `number` (number input), `select` (dropdown with options)
- [x] Required fields marked with asterisk, validated before submit
- [x] Collected metadata stored in anchor's `metadata` JSONB column on insert
- [x] `SecureDocumentDialog` (individual flow): optional metadata fields (no template required, free-form key-value pairs)
- [x] Recipient name/email field added (feeds into UF-03 recipient tracking)
- [x] File preview shown before confirmation: filename, file size, fingerprint preview (first 16 chars)
- [x] Pre-built template field schemas seeded for common types: DIPLOMA (institution, degree, graduation_date, honors), CERTIFICATE (issuing_body, cert_number, expiry_date), LICENSE (license_number, jurisdiction, expiry_date)
- [x] Tests: form renders fields from template, validates required fields, submits metadata correctly

### Files

- Edit: `src/components/organization/IssueCredentialForm.tsx` — dynamic metadata fields
- Edit: `src/components/anchor/SecureDocumentDialog.tsx` — optional metadata + file preview
- New: `src/components/credentials/MetadataFieldRenderer.tsx` — renders form fields from schema
- Edit: `supabase/seed.sql` — seed template field schemas for demo credential types
- Edit: `src/lib/validators.ts` — metadata validation against template schema
- Edit: `src/lib/copy.ts` — field labels, placeholders

---

## UF-06: Usage/Quota Tracking Dashboard

**Status:** COMPLETE
**Priority:** HIGH (billing UX gap)
**Depends on:** MVP-24 (credits schema — COMPLETE), P7-TS-02 (billing — COMPLETE)
**Completed:** 2026-03-16 (Sprint B, PR #61)

### Problem

Users don't see how many records they've used until they hit the limit and get a quota error. There's no usage bar, no "X of Y records used this month," no warning as they approach the limit. The `useEntitlements` hook enforces quotas but doesn't surface usage data proactively.

### What It Delivers

A usage tracking widget visible on the dashboard and billing page showing current period usage against plan limits.

### Acceptance Criteria

- [x] `UsageWidget` component: progress bar showing "X of Y records used this month" with color coding (green <50%, amber 50-80%, red >80%)
- [x] Widget shown on DashboardPage (sidebar or top of page)
- [x] Widget shown on PricingPage/BillingOverview
- [x] Warning toast at 80% usage: "You've used 80% of your monthly records. Upgrade for more."
- [x] Warning toast at 100%: "Monthly record limit reached. Upgrade to continue securing documents."
- [x] Credit balance shown if credits system active (MVP-24): "42 credits remaining"
- [x] Usage resets visible: "Resets on [next billing date]"
- [x] Free plan: clearly shows "3 of 3 records used — upgrade for more" with upgrade CTA
- [x] Tests: widget renders correctly at 0%, 50%, 80%, 100% usage

### Files

- New: `src/components/billing/UsageWidget.tsx`
- Edit: `src/pages/DashboardPage.tsx` — add UsageWidget
- Edit: `src/pages/PricingPage.tsx` — add UsageWidget to BillingOverview section
- Edit: `src/hooks/useEntitlements.ts` — expose usage counts (not just boolean enforcement)
- Edit: `src/lib/copy.ts` — usage messages

---

## UF-07: Enhanced Public Verification Display

**Status:** COMPLETE
**Priority:** HIGH (verifier experience)
**Depends on:** UF-01 (template rendering), UF-04 (PENDING status)
**Completed:** 2026-03-16 (Sprint B, PR #61)

### Problem

Public verification shows minimal information: filename, fingerprint, status, date. It doesn't show:
- Who issued it (org name, logo)
- What type of credential it is (diploma, certificate, license)
- Structured metadata (degree, institution, dates)
- Why a credential was revoked (if REVOKED)
- Downloadable proof for the verifier

### What It Delivers

Rich verification display using CredentialRenderer (UF-01) with issuer branding, structured metadata, revocation details, and verifier-accessible proof downloads.

### Acceptance Criteria

- [x] PublicVerification.tsx shows: issuer org name prominently, credential type badge, CredentialRenderer output (from UF-01)
- [x] REVOKED anchors show revocation reason and revocation date (from `revocation_reason` and `revoked_at` fields)
- [x] Proof package download available to public verifiers: JSON proof (existing) + simplified PDF summary
- [x] Issuer section links to issuer's public registry (UF-02) if org profile is public
- [x] Fingerprint displayed with copy button + helpful tooltip ("This is the document's unique digital fingerprint")
- [x] ExplorerLink shown for SECURED anchors with tooltip ("View the Bitcoin network receipt for this anchor")
- [x] Mobile-optimized layout for verification pages (verifiers often check on phone)
- [x] Tests: verify all display states (SECURED, PENDING, REVOKED) render correctly with full data

### Files

- Edit: `src/components/verification/PublicVerification.tsx` — enhanced display
- Edit: `src/components/public/PublicVerifyPage.tsx` — layout updates
- New: `src/components/verification/RevocationDetails.tsx` — revocation reason display
- New: `src/components/verification/VerifierProofDownload.tsx` — public proof download
- Edit: `src/lib/copy.ts` — verification page copy

---

## UF-08: Post-Issuance Actions + Share Flow

**Status:** COMPLETE
**Priority:** MEDIUM (usability)
**Depends on:** UF-04 (PENDING status UX)
**Completed:** 2026-03-15 (Sprint C, PR #62)

### Problem

After creating an anchor, the success dialog closes and the user is dumped back to wherever they were. There's no clear next step — no "Share this link," no "View record," no "Issue another." The share/verification URL is buried in the record detail page, requiring 3+ clicks to find.

### What It Delivers

Post-creation action sheet with one-click sharing, and persistent share actions on record views.

### Acceptance Criteria

- [x] Success screen (both SecureDocumentDialog and IssueCredentialForm) shows action buttons: "Copy Verification Link," "View Record," "Issue Another," "Done"
- [x] "Copy Verification Link" copies `{VITE_APP_URL}/verify/{publicId}` to clipboard with toast confirmation
- [x] "View Record" navigates to `/records/{id}` detail page
- [x] RecordDetailPage / AssetDetailView: prominent "Share" button that opens share sheet (copy link, QR code, email draft)
- [x] OrgRegistryTable row actions: add "Copy Link" quick action
- [x] QR code shown inline on record detail (already exists in AssetDetailView for SECURED — extend to always show with PENDING note)
- [x] Tests: ShareSheet tests (6 tests — render, QR code, copy link, email share, closed state)

### Files

- Edit: `src/components/anchor/SecureDocumentDialog.tsx` — action buttons on success
- Edit: `src/components/organization/IssueCredentialForm.tsx` — action buttons on success
- New: `src/components/anchor/ShareSheet.tsx` — share modal (copy link, QR, email)
- Edit: `src/components/anchor/AssetDetailView.tsx` — add Share button
- Edit: `src/components/organization/OrgRegistryTable.tsx` — add Copy Link row action
- Edit: `src/lib/copy.ts` — share flow copy

---

## UF-09: Org Context + Navigation Polish

**Status:** COMPLETE
**Priority:** MEDIUM (navigation clarity)
**Depends on:** None
**Completed:** 2026-03-15 (Sprint C, PR #62)

### Problem

Multiple navigation issues confuse users:
1. ORG_ADMIN sidebar doesn't show which organization they're managing
2. No back button on detail pages (must use browser back)
3. Silent auth redirects — no message when unauthenticated user hits protected route
4. Public profile toggle doesn't explain what becomes public
5. Copy-to-clipboard buttons have no success feedback

### What It Delivers

Navigation polish that makes the app feel complete and professional.

### Acceptance Criteria

- [x] Sidebar shows org name for ORG_ADMIN users (below logo or in sidebar header): "MANAGING: OrgName"
- [x] Detail pages (RecordDetailPage, AssetDetailView) show breadcrumb with back link: "Records > [filename]" with clickable "Records"
- [x] Auth redirect: when unauthenticated user hits protected route, redirect to login with toast: "Please sign in to access that page"
- [x] Settings > Privacy: public profile toggle description updated with clear explanation of what becomes public
- [x] All copy-to-clipboard buttons show toast: "Copied to clipboard"
- [x] SettingsPage: add "Sign Out" button at bottom (in addition to avatar dropdown)
- [x] Tests: Breadcrumbs tests (8 tests — top-level, record detail, credential templates, webhooks, API keys, billing, parent links)

### Files

- Edit: `src/components/layout/Sidebar.tsx` — org name display
- Edit: `src/components/layout/Header.tsx` — breadcrumb with back link
- Edit: `src/components/auth/AuthGuard.tsx` — toast on redirect
- Edit: `src/pages/SettingsPage.tsx` — enhanced privacy description, sign out button
- Edit: `src/lib/copy.ts` — navigation copy

---

## UF-10: Onboarding Completion + Empty State Guidance

**Status:** COMPLETE
**Priority:** MEDIUM (first-time experience)
**Depends on:** None
**Completed:** 2026-03-15 (Sprint C, PR #62)

### Problem

After onboarding, users land on an empty dashboard with no guidance. ORG_ADMIN users don't know they should: (1) create credential templates, (2) issue credentials, (3) set up billing. INDIVIDUAL users don't know they can secure documents. The empty state is unhelpful.

### What It Delivers

Guided first-time experience with checklist and contextual empty states.

### Acceptance Criteria

- [x] Post-onboarding welcome screen: "Welcome to Arkova! Here's how to get started" with role-specific steps
- [x] ORG_ADMIN checklist: (1) Create your first credential template, (2) Issue a credential, (3) Set up billing. Each step links to the relevant page. Checkmarks appear as steps are completed.
- [x] INDIVIDUAL checklist: (1) Secure your first document, (2) Share your verification link
- [x] DashboardPage empty state (0 records): shows the checklist prominently
- [x] Records page empty state: enhanced with CTA
- [x] Org Registry empty state: enhanced with CTA
- [x] Checklist persisted to localStorage (simple, no migration needed)
- [x] Checklist dismissible: "I know what I'm doing — skip setup"
- [x] Tests: GettingStartedChecklist tests (7 tests — ORG_ADMIN title, org steps, individual steps, completed steps, dismiss, already dismissed, progress bar)

### Files

- New: `src/components/onboarding/GettingStartedChecklist.tsx`
- Edit: `src/pages/DashboardPage.tsx` — integrate checklist in empty state
- Edit: `src/components/dashboard/EmptyState.tsx` — enhanced with CTA
- Edit: `src/components/organization/OrgRegistryTable.tsx` — empty state with CTA
- Edit: `src/lib/copy.ts` — onboarding guidance copy

---

## Dependency Graph

```
UF-01 (Template Rendering)     ←── foundational, no new deps
  ↓
UF-05 (Metadata Entry)         ←── uses same field schema as UF-01
UF-07 (Enhanced Verification)  ←── uses CredentialRenderer from UF-01
  ↓
UF-02 (Public Discovery)       ←── needs new migration (search RPCs)
  ↓ (partial)
UF-03 (Recipient Inbox)        ←── needs UF-01 for rendering, new migration

UF-04 (PENDING Status UX)      ←── independent, high priority
  ↓
UF-08 (Post-Issuance Actions)  ←── needs UF-04 for PENDING messaging

UF-06 (Usage Tracking)         ←── independent
UF-09 (Nav Polish)             ←── independent
UF-10 (Onboarding Guidance)    ←── independent
```

**Recommended build order:**
1. ~~**Sprint A (Critical):** UF-01, UF-04 (parallel — foundational)~~ DONE (2026-03-16, PR #60)
2. ~~**Sprint B (High):** UF-05, UF-02, UF-06, UF-07 (parallel after UF-01)~~ DONE (2026-03-16, PR #61)
3. ~~**Sprint C (Medium):** UF-03, UF-08, UF-09, UF-10 (parallel after Sprint B)~~ DONE (2026-03-15, PR #62)

---

## Change Log

| Date | Change |
|------|--------|
| 2026-03-16 | Initial creation — 3 stories identified from user flow gap analysis |
| 2026-03-16 | Expanded to 10 stories after full 8-flow UAT walkthrough. Added: UF-04 (PENDING status), UF-05 (metadata entry), UF-06 (usage tracking), UF-07 (verification display), UF-08 (share flow), UF-09 (nav polish), UF-10 (onboarding guidance) |
| 2026-03-16 | Sprint A COMPLETE (PR #60): UF-01 + UF-04. Migration 0054 applied to production. |
| 2026-03-16 | Sprint B COMPLETE (PR #61): UF-02, UF-05, UF-06, UF-07. Migration 0055 applied to production. 556 total frontend tests. All review comments addressed. |
| 2026-03-15 | Sprint C COMPLETE (PR #62): UF-03, UF-08, UF-09, UF-10. Migration 0056 (anchor_recipients). +30 tests (586 total frontend). All 10 UF stories now COMPLETE. |
