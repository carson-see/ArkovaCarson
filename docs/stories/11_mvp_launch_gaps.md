# MVP Launch Gap Stories

_Last updated: 2026-03-15 ~6:00 PM EST_

## Group Overview

These stories were identified during the 2026-03-12 full audit. They represent gaps between the current codebase and a fully testable MVP on Bitcoin Signet testnet, plus forward-looking features (credits, GCP deployment, LinkedIn badges) planned for Phase 2+. The audit document lives at `docs/audit/2026-03-12_full_audit.md`.

**Priority:** These are launch-blocking for testnet MVP. They should be completed before Phase 1.5 (P4.5 Verification API) or P8 (AI Implementation).

**Note:** AI-specific stories (MVP-19, MVP-22) were superseded by P8 AI Intelligence stories and removed from this group. See `docs/stories/12_p8_ai_intelligence.md`.

### Completion Summary

| Status | Count |
|--------|-------|
| COMPLETE | 15 |
| PARTIAL | 0 |
| NOT STARTED | 12 |
| REMOVED (superseded) | 2 |

---

## MVP-01: Worker Production Deployment (Google Cloud Run)

**Status:** COMPLETE (OPS-ONLY items remain)
**Priority:** CRITICAL (blocks testnet launch)
**Depends on:** P7-TS-05 (Bitcoin chain client), MVP-26 (GCP Cloud Run setup)
**Completed:** 2026-03-16 (PR #50 — deploy prep, `.env.example`, health check, deploy workflow)
**Operational items:** Set Cloud Run env vars, register Stripe webhook endpoint. See `docs/confluence/15_operational_runbook.md`.

### What It Delivers

Deploy the Express worker service to Google Cloud Run so the anchor processing pipeline, Stripe webhooks, and cron jobs can run outside localhost. GCP chosen for Google startup credits program compatibility.

### Acceptance Criteria

- [ ] Worker deployed to Cloud Run with health check endpoint responding
- [ ] Secrets configured via GCP Secret Manager (Supabase service role, Stripe keys, Bitcoin treasury WIF)
- [ ] Cloud Scheduler triggers cron jobs (anchor processing, webhook retries, report generation)
- [ ] Stripe webhook URL configured and receiving events
- [ ] `ENABLE_PROD_NETWORK_ANCHORING=true` on deployment (Signet)
- [ ] Cloud Build CI/CD pipeline deploys on merge to main
- [ ] Cloud Logging accessible for debugging

### Files

- `services/worker/` (existing — no code changes needed)
- `services/worker/Dockerfile` (exists — multi-stage build)
- New: `services/worker/.dockerignore`
- New: `cloudbuild.yaml` or `.github/workflows/deploy-worker-gcp.yml`
- New: Cloud Run service configuration (Terraform or `gcloud` CLI scripts)

### Security Notes

- Service role key must be in GCP Secret Manager, never in code
- `BITCOIN_TREASURY_WIF` loaded from Secret Manager, never logged
- Health endpoint must not expose internal state
- Cloud Run service account should have minimal IAM permissions

---

## MVP-02: Toast/Notification System

**Status:** COMPLETE
**Priority:** HIGH (UX gap)
**Depends on:** None

### What It Delivers

Global toast notification system using Sonner. All mutation hooks now show success/error toasts.

### Implementation

- Sonner `<Toaster />` wired in App.tsx (position="top-right", richColors, closeButton) ✅
- Toast calls in `useProfile.ts` (success + error) ✅
- Toast calls in `useOrganization.ts` (success + error) ✅
- Toast calls in `useBulkAnchors.ts` ✅
- Toast calls in `useCredentialTemplates.ts` (CRUD success + error) ✅
- Toast calls in `useRevokeAnchor.ts` (success + error) ✅
- Toast calls in `useInviteMember.ts` (success + error) ✅
- TOAST constants in `src/lib/copy.ts` for all messages ✅

### Acceptance Criteria

- [x] Sonner `<Toaster />` added to App.tsx (global)
- [x] Success toast on: anchor creation, profile save, org settings save, member invite, credential template CRUD
- [x] Error toast on: all Supabase query failures, validation errors
- [ ] Warning toast on: approaching quota limit (deferred — useEntitlements handles this via UpgradePrompt)
- [x] Toast styling matches Arkova brand (Steel Blue accent)

### Files

- `src/App.tsx` — `<Toaster />`
- `src/hooks/useProfile.ts`, `useOrganization.ts`, `useBulkAnchors.ts` — toast calls (Sprint 2)
- `src/hooks/useCredentialTemplates.ts`, `useRevokeAnchor.ts`, `useInviteMember.ts` — toast calls (PR #36)
- `src/lib/copy.ts` — TOAST constants

---

## MVP-03: Legal Pages (Privacy, Terms, Contact)

**Status:** COMPLETE
**Priority:** HIGH (dead links in production)
**Depends on:** None
**Completed:** 2026-03-14

### What It Delivers

Static legal pages at `/privacy`, `/terms`, and `/contact`. Previously these routes were linked from PublicVerifyPage footer and AuthLayout but returned 404.

### Acceptance Criteria

- [x] `/privacy` route renders Privacy Policy page (108 lines)
- [x] `/terms` route renders Terms of Service page (115 lines)
- [x] `/contact` route renders Contact page (86 lines)
- [x] All three pages are public (no auth required)
- [x] Footer links in PublicVerifyPage and AuthLayout work
- [x] Pages use consistent layout with Arkova header/footer
- [x] Content is placeholder but professional (can be updated with legal review later)

### Files

- `src/pages/PrivacyPage.tsx` (108 lines)
- `src/pages/TermsPage.tsx` (115 lines)
- `src/pages/ContactPage.tsx` (86 lines)
- `src/lib/routes.ts` — PRIVACY, TERMS, CONTACT routes defined
- `src/App.tsx` — routes wired (lines 103-105)

---

## MVP-04: Brand Assets (Logo, Favicon, OG Tags)

**Status:** COMPLETE
**Priority:** HIGH (professional appearance)
**Depends on:** None
**Completed:** 2026-03-14 (PR #30)

### What It Delivers

Real brand assets replacing the Shield icon placeholder. Favicon, OG meta tags for social sharing, and logo component.

### Acceptance Criteria

- [x] SVG logo in `public/` directory — `favicon.svg`, `og-image.svg`
- [x] Favicon set — `public/favicon.svg` (bear logo)
- [x] `index.html` has: meta description, OG title/description/image, Twitter card tags
- [x] ArkovaLogo component created (`src/components/layout/ArkovaLogo.tsx`)
- [x] Logo works on both light and dark backgrounds (variant prop)

### Files

- `public/favicon.svg` — bear logo favicon
- `public/og-image.svg` — OG social sharing image
- `src/components/layout/ArkovaLogo.tsx` — brand logo component with light/dark variants
- `index.html` — OG + Twitter meta tags (lines 13-20)

---

## MVP-05: Error Boundary + 404 Page

**Status:** COMPLETE
**Priority:** HIGH (error handling)
**Depends on:** None
**Completed:** 2026-03-14

### What It Delivers

React Error Boundary wrapping the app to catch render crashes, plus a proper 404 page for unknown routes.

### Acceptance Criteria

- [x] Error boundary catches React render errors and shows recovery UI (83 lines, Shield + RefreshCw icons)
- [x] 404 page at catch-all route with "Go to Dashboard" link (35 lines)
- [x] Error boundary logs errors to Sentry (`Sentry.captureException`) + console in dev
- [x] Both pages match Arkova brand styling

### Files

- `src/components/layout/ErrorBoundary.tsx` (83 lines) — wraps App in App.tsx (line 78)
- `src/pages/NotFoundPage.tsx` (35 lines) — catch-all route `<Route path="*">` (line 269)
- `src/App.tsx` — ErrorBoundary wraps all content, NotFoundPage at catch-all route

---

## MVP-06: File-Based Public Verification

**Status:** NOT STARTED
**Priority:** MEDIUM (usability)
**Depends on:** P6-TS-01

### What It Delivers

Allow public verification by dragging a file onto the verification page. The file is fingerprinted client-side and the fingerprint is looked up against the anchor database.

### Acceptance Criteria

- [ ] Drop zone on PublicVerifyPage accepts file drag-and-drop
- [ ] File is fingerprinted client-side using `generateFingerprint`
- [ ] Fingerprint is looked up via Supabase RPC or query
- [ ] If found, shows verification result (same as ID-based lookup)
- [ ] If not found, shows "Document not found in registry" message
- [ ] File never leaves the browser (Constitution 1.6)
- [ ] Tab UI to switch between "Verify by ID" and "Verify by File"

### Files

- `src/components/verify/VerificationForm.tsx` — add file upload tab
- `src/components/public/PublicVerifyPage.tsx` — layout update
- `src/lib/fileHasher.ts` — already exists, reuse

---

## MVP-07: Mobile Responsive Layout

**Status:** COMPLETE
**Priority:** MEDIUM (usability)
**Depends on:** None
**Completed:** 2026-03-14 (PR #43)

### What It Delivers

Responsive sidebar with hamburger menu on mobile. Sidebar collapses on screens < 768px and opens as an overlay with backdrop.

### Acceptance Criteria

- [x] Sidebar collapses to hamburger menu on screens < 768px
- [x] Mobile menu opens as overlay or slide-in drawer
- [x] All navigation items accessible on mobile
- [x] Dashboard stats grid stacks on mobile (1 column)
- [x] Tables horizontally scroll on mobile (shadcn Table already wraps in overflow-auto)
- [x] Touch-friendly tap targets (min 44px)

### Implementation

- `src/components/layout/Sidebar.tsx` — rewritten with `mobileOpen`/`onMobileClose` props, overlay with `bg-black/50` backdrop, auto-close on navigation
- `src/components/layout/AppShell.tsx` — hamburger menu button (`Menu` icon) visible on `md:hidden`, responsive content padding
- `src/components/layout/Header.tsx` — border/height managed by AppShell container
- `src/components/public/ProofDownload.tsx` — responsive grid stacking on mobile

---

## MVP-08: Onboarding Progress Stepper

**Status:** COMPLETE
**Priority:** MEDIUM (usability)
**Depends on:** P2-TS-0X (onboarding routes)
**Completed:** 2026-03-14 (PR #44)

### What It Delivers

Visual progress indicator in the onboarding flow showing which step the user is on (1. Account Type → 2. Organization → 3. Confirmation).

### Acceptance Criteria

- [x] Step indicator visible on all onboarding pages
- [x] Current step highlighted, completed steps marked with checkmark
- [x] Steps: Account Type → Organization → Confirmation
- [x] Responsive: step descriptions hidden on mobile (`hidden sm:block`)

### Implementation

- `src/components/onboarding/OnboardingStepper.tsx` — new reusable stepper component with numbered circles, checkmarks, connector lines, three visual states (completed/current/upcoming)
- `src/components/onboarding/index.ts` — barrel exports for `OnboardingStepper` + `OnboardingStep` type
- `src/pages/OnboardingRolePage.tsx` — stepper at step 0 (Account Type)
- `src/pages/OnboardingOrgPage.tsx` — stepper at step 1 (Organization)
- `src/lib/copy.ts` — `ONBOARDING_LABELS` constants for step labels and descriptions

---

## MVP-09: Records Pagination + Search

**Status:** COMPLETE
**Priority:** MEDIUM (scalability)
**Depends on:** P3-TS-01
**Completed:** 2026-03-14 (PR #44)

### What It Delivers

Client-side search, filter, and pagination for the records/dashboard view. Search by filename or fingerprint, filter by status, configurable page sizes.

### Acceptance Criteria

- [x] Records list paginates (10/25/50 per page, default 10)
- [x] Previous/Next + numbered page controls with ellipsis
- [x] Search by document name or fingerprint
- [x] Filter by status (All, PENDING, SECURED, REVOKED)
- [x] Sort by date (newest first default — from useAnchors)
- [x] "No results" empty state when filters match nothing

### Implementation

- `src/pages/DashboardPage.tsx` — search input, status dropdown, pagination controls, `useMemo` for filtered/paginated records
- `src/lib/copy.ts` — `RECORDS_LIST_LABELS` constants for search, filter, pagination copy

---

## MVP-10: Marketing Website (arkova.ai)

**Status:** COMPLETE
**Priority:** MEDIUM (go-to-market)
**Depends on:** MVP-04 (brand assets)
**Completed:** 2026-03-15. Built as separate Vite+React project with Nordic Vault aesthetic. GitHub: `carson-see/arkova-marketing`. Pending: Vercel deployment + custom domain.

### What It Delivers

Public marketing website at arkova.ai explaining what Arkova does, how it works, and pricing. Separate from the app (could be a simple static site or Vite app).

### Acceptance Criteria

- [ ] Hero section with value proposition
- [ ] "How It Works" section (3-step process)
- [ ] Features section with use cases
- [ ] Pricing section (matches Stripe plans)
- [ ] Trust indicators (Signet transaction proof, security features)
- [ ] CTA buttons linking to app signup
- [ ] Responsive design (mobile-first)
- [ ] Deployed to arkova.ai domain

### Files

- New project or `src/pages/MarketingPage.tsx` (depends on architecture decision)
- Design spec in `docs/audit/2026-03-12_full_audit.md` Section 6

---

## MVP-11: Stripe Plan Change/Downgrade (CRIT-3 Remaining)

**Status:** COMPLETE
**Priority:** HIGH (billing completeness)
**Depends on:** P7-TS-02 (Stripe checkout — partial)
**Completed:** 2026-03-14 (PR #43)

### What It Delivers

Complete Stripe billing flow with plan upgrades, downgrades, and cancellations via Stripe Billing Portal. Webhook handlers detect plan changes and log audit events.

### Acceptance Criteria

- [x] Users can upgrade from Free to Pro/Enterprise (via Billing Portal)
- [x] Users can downgrade (effective at end of billing period, via Billing Portal)
- [x] Users can cancel subscription (via Billing Portal)
- [x] Entitlements adjust on webhook `customer.subscription.updated`
- [x] Webhook handlers detect plan changes by resolving plan_id from Stripe price items
- [x] PricingPage routes existing subscribers to Billing Portal, new users to Checkout
- [x] UI shows "Current Plan" badge on active plan in PricingPage

### Implementation

- `services/worker/src/stripe/handlers.ts` — enhanced `handleSubscriptionUpdated` with plan change detection (resolves plan_id from subscription price items, compares to existing, logs audit events), cancellation scheduled handling
- `services/worker/src/stripe/handlers.test.ts` — 7 new tests: plan change detection, same plan no-op, cancellation scheduled, missing items, unresolvable price (44 total handler tests)
- `src/pages/PricingPage.tsx` — routes existing subscribers to billing portal, "Current Plan" badge
- `src/lib/copy.ts` — billing copy: `MANAGE_SUBSCRIPTION`, `PLAN_CHANGE_VIA_PORTAL`, `CURRENT_PLAN_BADGE`, `DOWNGRADE_NOTE`, `CANCELLATION_SCHEDULED`

---

## MVP-12: Dark Mode Toggle

**Status:** NOT STARTED
**Priority:** LOW (polish)
**Depends on:** None

### What It Delivers

Dark mode toggle in Settings or header. CSS custom properties already defined in `src/index.css` for `.dark` class.

### Acceptance Criteria

- [ ] Toggle switch in Settings page (or header)
- [ ] Persisted to localStorage
- [ ] Respects system preference on first visit
- [ ] All pages render correctly in dark mode
- [ ] Sidebar, cards, inputs, badges all themed

### Files

- `src/index.css` — already has `.dark` block
- New: `src/hooks/useTheme.ts`
- `src/components/layout/Header.tsx` — add toggle

---

## MVP-13: Organization Logo Upload

**Status:** NOT STARTED
**Priority:** LOW (polish)
**Depends on:** P5-TS-03

### What It Delivers

Organizations can upload a logo that appears in verification results and proof packages.

### Acceptance Criteria

- [ ] Logo upload in Organization Settings
- [ ] Stored in Supabase Storage bucket
- [ ] Displayed in org header, verification results, proof PDFs
- [ ] Max size 2MB, formats: PNG, JPG, SVG
- [ ] Fallback to organization initial if no logo

### Files

- `src/pages/OrgSettingsPage.tsx` — add logo upload
- `src/hooks/useOrganization.ts` — logo URL field
- Supabase Storage bucket creation (migration or manual)

---

## MVP-14: Embeddable Verification Widget (P6-TS-03 Completion)

**Status:** NOT STARTED
**Priority:** LOW (post-launch)
**Depends on:** P6-TS-03 (partial)

### What It Delivers

Complete the orphaned VerificationWidget by routing it and/or bundling it as a standalone embeddable script.

### Acceptance Criteria

- [ ] Widget accessible at a dedicated route (e.g., `/embed/verify`)
- [ ] OR: Bundled as standalone JS that can be embedded via `<script>` tag
- [ ] Widget accepts `publicId` parameter
- [ ] Shows verification status, issuer, timestamp
- [ ] Styled independently (doesn't require host page CSS)
- [ ] Documentation for embedding

### Files

- `src/components/embed/VerificationWidget.tsx` — already exists
- `src/App.tsx` — add route OR separate Vite config for standalone build

---

## MVP-16: Block Explorer Deep Links

**Status:** NOT STARTED
**Priority:** MEDIUM (transparency feature)
**Depends on:** P7-TS-05 (Bitcoin chain client), P7-TS-13 (chain index)

### What It Delivers

Add a "View on Network" link to SECURED anchors that deep-links to the Bitcoin transaction on mempool.space. Uses `anchor_chain_index` table to look up `chain_tx_id` from the anchor's fingerprint, then constructs a `mempool.space/signet/tx/{txid}` URL.

### Acceptance Criteria

- [ ] SECURED anchors show "View on Network" link in AssetDetailView
- [ ] Link opens `https://mempool.space/signet/tx/{chain_tx_id}` in new tab
- [ ] Link also appears in PublicVerification.tsx (public verify page)
- [ ] Link hidden for PENDING/REVOKED anchors (no TX ID exists)
- [ ] UI label uses allowed terminology ("View Network Receipt" — not "View Transaction")
- [ ] Graceful fallback if `chain_tx_id` is NULL (link not shown)
- [ ] Network prefix switches based on `BITCOIN_NETWORK` env var (signet/testnet/mainnet)

### Files

- `src/components/anchor/AssetDetailView.tsx` — add deep link
- `src/components/verification/PublicVerification.tsx` — add deep link
- `src/lib/copy.ts` — add "View Network Receipt" string
- `src/hooks/useAnchors.ts` — include `chain_tx_id` join from `anchor_chain_index`

### Technical Notes

- Fingerprint → TX ID mapping lives in `anchor_chain_index` table (migration 0050)
- Two distinct values: `file_fingerprint_sha256` (document hash) and `chain_tx_id` (Bitcoin receipt)
- URL pattern: `https://mempool.space/{network}/tx/{chain_tx_id}` where network = signet | testnet | (empty for mainnet)

---

## MVP-17: Credential Template Metadata Enhancement

**Status:** NOT STARTED
**Priority:** MEDIUM (usability)
**Depends on:** P5-TS-07 (credential templates)

### What It Delivers

Enhance credential templates to define metadata field schemas that pre-fill the metadata form when creating anchors. Currently `credential_templates.default_metadata` is JSONB but not used during anchor creation.

### Acceptance Criteria

- [ ] Template `default_metadata` defines field names, types, and defaults
- [ ] When user selects a credential type during anchor creation, metadata fields auto-populate
- [ ] Supported field types: text, date, number, select (dropdown)
- [ ] Field validation rules from template (required, min/max, regex pattern)
- [ ] Pre-built templates for common types: diploma (institution, degree, grad date, GPA), certificate (issuing body, cert number, expiry), license (license number, jurisdiction, expiry)
- [ ] Template editor in CredentialTemplatesManager shows field schema builder
- [ ] Migration adds `metadata_schema` JSONB column to `credential_templates` table

### Files

- New migration: `supabase/migrations/0051_credential_template_schema.sql`
- `src/components/credentials/CredentialTemplatesManager.tsx` — schema builder UI
- `src/components/anchor/SecureDocumentDialog.tsx` — pre-fill from template
- `src/components/organization/IssueCredentialForm.tsx` — pre-fill from template
- `src/lib/validators.ts` — template schema validation

---

## MVP-18: Enhanced Metadata Display

**Status:** NOT STARTED
**Priority:** MEDIUM (UX polish)
**Depends on:** MVP-17 (template metadata enhancement)

### What It Delivers

Rich metadata rendering on verification pages. Currently metadata is shown as raw JSON. This story adds structured display with labels, formatting, and visual hierarchy.

### Acceptance Criteria

- [ ] Metadata rendered as labeled key-value pairs (not raw JSON)
- [ ] Date fields formatted as human-readable dates
- [ ] Fields grouped by category if template defines groups
- [ ] Empty/null fields hidden (not shown as "null")
- [ ] Metadata section in PublicVerification.tsx matches brand styling
- [ ] AssetDetailView shows same structured metadata
- [ ] Fallback to raw JSON display if no template schema exists

### Files

- New: `src/components/verification/MetadataDisplay.tsx`
- `src/components/verification/PublicVerification.tsx` — use MetadataDisplay
- `src/components/anchor/AssetDetailView.tsx` — use MetadataDisplay

---

## ~~MVP-19: AI Auto-Descriptions~~ — REMOVED

> **Superseded by P8-S4 (Metadata Field Extraction) and P8-S5 (Smart Description Generation).** See `docs/stories/12_p8_ai_intelligence.md`.

---

## MVP-20: LinkedIn Badge Integration (Phase 2)

**Status:** NOT STARTED
**Priority:** LOW (Phase 2 feature)
**Depends on:** P6-TS-01 (public verification), MVP-18 (metadata display)

### What It Delivers

Allow credential recipients to share verified credentials on LinkedIn. Two approaches: (1) LinkedIn Add-to-Profile URL API (simpler), or (2) OpenBadges v3 JSON-LD (standards-based). Start with Add-to-Profile.

### Acceptance Criteria

- [ ] "Share on LinkedIn" button on public verification page (SECURED anchors only)
- [ ] Button generates LinkedIn Add-to-Profile URL with: credential name, issuing org, issue date, verification URL
- [ ] Verification URL (`https://app.arkova.io/verify/{publicId}`) serves as the credential evidence
- [ ] Button hidden for REVOKED/PENDING anchors
- [ ] Org admin can enable/disable LinkedIn sharing per credential template
- [ ] No LinkedIn API key required (Add-to-Profile is a URL scheme)

### Files

- `src/components/verification/PublicVerification.tsx` — add LinkedIn button
- New: `src/lib/linkedin.ts` — URL builder for Add-to-Profile
- `src/lib/copy.ts` — "Share on LinkedIn" string

### Technical Notes

- LinkedIn Add-to-Profile URL: `https://www.linkedin.com/profile/add?startTask=CERTIFICATION_NAME&name={name}&organizationName={org}&issueYear={year}&issueMonth={month}&certUrl={verifyUrl}&certId={publicId}`
- No LinkedIn integration exists in the codebase today.
- OpenBadges v3 (JSON-LD with cryptographic proof) is a future enhancement.
- Phase 2 only — no LinkedIn dependencies for MVP launch.

---

## MVP-21: Individual Self-Verification Flow

**Status:** NOT STARTED
**Priority:** MEDIUM (user journey gap)
**Depends on:** P4-TS-01 (anchor creation), P6-TS-01 (public verification)

### What It Delivers

Allow individual users (non-org) to anchor and verify their own documents. Currently the UI is heavily org-focused. This adds a simplified flow for individuals who want to prove document existence/integrity.

### Acceptance Criteria

- [ ] Individual user sees "Secure a Document" CTA on dashboard
- [ ] Simplified anchor creation: file upload → fingerprint → confirm → anchor
- [ ] No credential type or metadata required (optional fields)
- [ ] Individual can view their anchored documents in a personal vault
- [ ] Individual can share verification link with anyone
- [ ] Public verification page works identically for individual and org anchors
- [ ] Individual Free tier: 3 anchors/month (existing quota)

### Files

- `src/components/dashboard/` — individual-specific dashboard view
- `src/components/anchor/SecureDocumentDialog.tsx` — simplify for individuals
- `src/pages/DashboardPage.tsx` — role-conditional rendering

---

## ~~MVP-22: AI Fraud Detection~~ — REMOVED

> **Superseded by P8-S7 (Anomaly Detection Engine), P8-S8 (Duplicate Detection), and P8-S9 (Admin Review Queue).** See `docs/stories/12_p8_ai_intelligence.md`.

---

## MVP-23: Batch Anchor Processing

**Status:** NOT STARTED
**Priority:** MEDIUM (cost optimization)
**Depends on:** MVP-24 (credits system), P7-TS-05 (Bitcoin chain client)

### What It Delivers

Batch anchor processing to reduce per-anchor Bitcoin fees: queue multiple anchors and broadcast as a Merkle root in a single OP_RETURN TX. Includes usage analytics for orgs.

> **Note:** AI-specific cost optimization (intelligent fee timing via LLM) has been moved to P8. This story covers the non-AI batch processing and usage analytics only. See also P8-S2 (Batch Anchor Processing) in `docs/stories/12_p8_ai_intelligence.md` for the AI-enhanced version.

### Acceptance Criteria

- [ ] Batch processing: queue anchors and broadcast as Merkle root in single TX
- [ ] Fee estimation: suggest optimal submission time based on mempool congestion (rule-based, not AI)
- [ ] Usage analytics dashboard: cost per anchor, monthly spend, projected costs
- [ ] Batch size configurable per org (default: 10 anchors per TX)
- [ ] Estimated savings displayed to user ("Batching saves ~$X per anchor")
- [ ] Feature gated behind `ENABLE_BATCH_ANCHORING` flag

### Files

- New: `services/worker/src/jobs/batch-anchor.ts` — batch processing job
- New: `src/components/billing/UsageAnalytics.tsx` — cost dashboard
- `services/worker/src/chain/fee-estimator.ts` — enhanced fee timing
- `src/lib/switchboard.ts` — add `ENABLE_BATCH_ANCHORING` flag

### Technical Notes

- Current anchoring: 1 TX per anchor (OP_RETURN with single fingerprint)
- Batch anchoring: Merkle tree of N fingerprints → single OP_RETURN with Merkle root
- Requires new `anchor_batches` table to track batch→anchor relationships
- Bitcoin fee savings: ~$0.01-0.05 per anchor at current Signet rates (more significant on mainnet)

---

## MVP-24: Credits Schema + Monthly Allocations

**Status:** NOT STARTED
**Priority:** MEDIUM (billing enhancement)
**Depends on:** P7-TS-02 (Stripe checkout — partial)

### What It Delivers

Hybrid billing model: keep existing subscriptions (quota-based) + add monthly credit allocations per tier for network fees and AI usage. Additional credits purchasable via Stripe one-time payments.

**Monthly credit allocations per tier:**

| Tier | Monthly Credits | Overage |
|------|----------------|---------|
| Free | 50 | Blocked (upgrade prompt) |
| Pro | 500 | Purchase additional packs |
| Enterprise | 5,000 | Purchase additional packs |

1 credit ≈ 1 anchor operation (Bitcoin TX fee) or ~10 AI operations (metadata extraction, description generation).

### Acceptance Criteria

- [ ] New `credit_balances` table: `org_id`, `balance_credits`, `monthly_allocation`, `lifetime_purchased`, `lifetime_used`, `last_allocation_at`
- [ ] New `credit_transactions` table: `id`, `org_id`, `amount`, `type` (ALLOCATION/PURCHASE/USAGE/REFUND/EXPIRY), `description`, `stripe_payment_id`, `created_at`
- [ ] Monthly credit allocation on subscription renewal (cron job or Stripe webhook)
- [ ] Unused credits expire at end of billing period (do not roll over)
- [ ] Stripe one-time payment endpoint for additional credit packs ($10, $25, $50, $100 presets)
- [ ] Purchased credits do not expire (only monthly allocations expire)
- [ ] Credits deducted on anchor SECURED (after successful Bitcoin broadcast)
- [ ] Credits deducted on AI operations (metadata extraction, description generation)
- [ ] Credit balance shown in billing settings with breakdown (allocated vs purchased)
- [ ] Low-balance warning at 10% remaining
- [ ] Anchor/AI creation blocked (with upgrade prompt) when credits exhausted on Free tier
- [ ] RLS: orgs can only see their own credit balance/transactions
- [ ] Migration includes rollback comments

### Files

- New migration: `supabase/migrations/0054_credit_system.sql` (next available after P4.5 migrations 0051-0053)
- New: `src/hooks/useCredits.ts` — credit balance + transaction queries
- `src/pages/SettingsPage.tsx` — credit balance + purchase UI
- `services/worker/src/stripe/handlers.ts` — allocation on subscription renewal + one-time payment handler
- `services/worker/src/jobs/anchor.ts` — deduct credits on SECURED
- `src/lib/validators.ts` — credit purchase validation
- New: `services/worker/src/jobs/credit-allocation.ts` — monthly allocation cron

### Technical Notes

- Subscriptions stay for access tiers (Free/Pro/Enterprise) and monthly record quotas
- Credits cover variable costs: Bitcoin TX fees + AI usage (P8 stories)
- Credit deduction happens in worker (service_role) — never client-side
- Monthly allocation triggered by `invoice.paid` webhook or cron job
- Stripe Products: one-time price objects for each credit pack
- Exchange rate: 1 credit ≈ 1 anchor TX fee. AI operations cost fractional credits (~0.1 per call).
- Unused monthly credits expire to prevent accumulation on Free tier

---

## MVP-25: Credits Tracking + Scheduling

**Status:** NOT STARTED
**Priority:** LOW (Phase 2 enhancement)
**Depends on:** MVP-24 (credits schema)

### What It Delivers

Usage dashboard for credits, auto-refill option, and scheduled anchoring (queue documents for batch processing at low-fee times).

### Acceptance Criteria

- [ ] Credits usage dashboard: current balance, 30-day spend chart, per-anchor cost breakdown
- [ ] Auto-refill toggle: automatically purchase credits when balance drops below threshold
- [ ] Scheduled anchoring: user can queue documents for "next low-fee window" (worker picks optimal time)
- [ ] Email notification when credits are low (10% remaining)
- [ ] Credit transaction history with export (CSV)

### Files

- New: `src/components/billing/CreditsDashboard.tsx`
- `src/hooks/useCredits.ts` — add usage analytics queries
- `services/worker/src/jobs/anchor.ts` — scheduled anchoring logic
- New: `services/worker/src/stripe/auto-refill.ts`

---

## MVP-26: GCP Cloud Run Deployment

**Status:** NOT STARTED
**Priority:** HIGH (infrastructure — blocks MVP-01)
**Depends on:** None (infrastructure setup)

### What It Delivers

Deploy the worker service to Google Cloud Run. This is the infrastructure foundation for MVP-01 (worker production deployment). Uses Google startup credits.

### Acceptance Criteria

- [ ] Cloud Run service created for worker container
- [ ] Dockerfile builds and deploys successfully to Cloud Run
- [ ] Health check endpoint (`/health`) configured and responding
- [ ] Cloud Run service scales to zero when idle (cost optimization)
- [ ] Min instances: 1 (to avoid cold start delays for webhooks)
- [ ] Memory: 512MB, CPU: 1 vCPU (adjustable)
- [ ] Cloud Run service account with minimal IAM permissions
- [ ] Custom domain mapped (e.g., `worker.arkova.io`)
- [ ] HTTPS enforced (Cloud Run default)

### Files

- `services/worker/Dockerfile` (exists)
- New: `services/worker/.dockerignore` (partial — needs completion)
- New: `infrastructure/gcp/cloud-run.tf` (Terraform) or `scripts/deploy-cloud-run.sh` (CLI)
- New: `docs/confluence/15_gcp_deployment.md`

### Technical Notes

- Cloud Run supports container images, HTTP triggers, and always-on instances
- Worker Express server needs `PORT` env var (Cloud Run sets this automatically)
- Cloud Run max request timeout: 3600s (sufficient for anchor processing)
- Startup credits: verify Cloud Run costs against credit balance

---

## MVP-27: GCP Secret Manager Integration

**Status:** NOT STARTED
**Priority:** HIGH (security — blocks MVP-01)
**Depends on:** MVP-26 (Cloud Run deployment)

### What It Delivers

Migrate all worker secrets from environment variables to GCP Secret Manager. Cloud Run services access secrets via mounted volumes or environment variable injection from Secret Manager.

### Acceptance Criteria

- [ ] All worker secrets stored in GCP Secret Manager: `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `BITCOIN_TREASURY_WIF`, `API_KEY_HMAC_SECRET`
- [ ] Cloud Run service configured to inject secrets as env vars from Secret Manager
- [ ] Secret rotation supported (new versions without downtime)
- [ ] IAM: only worker service account can access worker secrets
- [ ] No secrets in Dockerfile, cloudbuild.yaml, or source code
- [ ] Local development still uses `.env` file (no GCP dependency for local dev)

### Files

- New: `infrastructure/gcp/secrets.tf` or `scripts/setup-secrets.sh`
- `services/worker/src/config.ts` — no changes needed (reads from env vars regardless of source)

---

## MVP-28: GCP Cloud Scheduler

**Status:** NOT STARTED
**Priority:** HIGH (infrastructure — blocks MVP-01 cron jobs)
**Depends on:** MVP-26 (Cloud Run deployment)

### What It Delivers

Replace the worker's internal cron scheduler with GCP Cloud Scheduler for production reliability. Cloud Scheduler sends HTTP requests to Cloud Run endpoints on a schedule.

### Acceptance Criteria

- [ ] Cloud Scheduler jobs created for: anchor processing (every 1 min), webhook retries (every 5 min), report generation (daily)
- [ ] Each job hits a dedicated Cloud Run endpoint (e.g., `POST /cron/process-anchors`)
- [ ] Jobs authenticated via OIDC token (Cloud Scheduler → Cloud Run)
- [ ] Job failure alerts via Cloud Monitoring
- [ ] Cron endpoints protected: only Cloud Scheduler service account can call them
- [ ] Local development: internal cron still works (no Cloud Scheduler dependency)

### Files

- New: `infrastructure/gcp/scheduler.tf` or `scripts/setup-scheduler.sh`
- `services/worker/src/index.ts` — add cron endpoint routes (alongside internal cron)
- New: `services/worker/src/api/cron.ts` — HTTP cron trigger handlers

### Technical Notes

- Cloud Scheduler supports cron expressions, retries, and dead-letter topics
- Worker currently uses `node-cron` internally — keep for local dev, Cloud Scheduler for production
- OIDC auth ensures only Cloud Scheduler can trigger cron endpoints

---

## MVP-29: GCP Cloud KMS Integration

**Status:** NOT STARTED
**Priority:** MEDIUM (security enhancement)
**Depends on:** MVP-26 (Cloud Run deployment), P7-TS-05 (Bitcoin chain client)

### What It Delivers

Add GCP Cloud KMS as an alternative key management option alongside AWS KMS. The existing `KmsSigningProvider` interface supports pluggable backends — this adds a GCP implementation.

### Acceptance Criteria

- [ ] New `GcpKmsSigningProvider` implements `SigningProvider` interface
- [ ] Supports secp256k1 key creation and signing (required for Bitcoin)
- [ ] Worker config: `KMS_PROVIDER=aws|gcp` selects which backend
- [ ] GCP KMS key ring and key creation documented
- [ ] Integration tests with mock GCP KMS client
- [ ] Operational docs: `docs/confluence/16_gcp_kms_operations.md`

### Files

- New: `services/worker/src/chain/gcp-kms-signing-provider.ts`
- `services/worker/src/chain/client.ts` — factory supports GCP KMS
- `services/worker/src/config.ts` — add `KMS_PROVIDER` config
- New: `docs/confluence/16_gcp_kms_operations.md`

### Technical Notes

- GCP Cloud KMS supports secp256k1 keys (required for Bitcoin signing)
- Existing `KmsSigningProvider` (AWS) in `signing-provider.ts` — can coexist with GCP version
- AWS KMS for mainnet (already designed), GCP KMS as backup/alternative
- Both KMS providers implement the same `SigningProvider` interface

---

## MVP-30: GCP CI/CD Pipeline

**Status:** NOT STARTED
**Priority:** HIGH (deployment automation — blocks MVP-01)
**Depends on:** MVP-26 (Cloud Run deployment)

### What It Delivers

Automated CI/CD pipeline that builds and deploys the worker to Cloud Run on merge to main. Can use Cloud Build (GCP-native) or GitHub Actions with GCP auth.

### Acceptance Criteria

- [ ] Pipeline triggers on push/merge to `main` branch
- [ ] Builds worker Docker image
- [ ] Pushes image to Google Artifact Registry
- [ ] Deploys to Cloud Run with zero-downtime rolling update
- [ ] Pipeline runs existing CI checks first (typecheck, lint, test)
- [ ] Deployment blocked if CI checks fail
- [ ] Deployment notifications (Slack or email)
- [ ] Rollback capability (deploy previous image tag)

### Files

- New: `cloudbuild.yaml` (if using Cloud Build) or `.github/workflows/deploy-worker-gcp.yml` (if using GitHub Actions)
- New: `infrastructure/gcp/artifact-registry.tf` or setup script

### Technical Notes

- Cloud Build is GCP-native, simpler IAM integration with Cloud Run
- GitHub Actions requires Workload Identity Federation for GCP auth (no service account keys)
- Recommend Cloud Build for simplicity with GCP credits program
- Artifact Registry replaces Container Registry (deprecated)

---

## Change Log

| Date | Change |
|------|--------|
| 2026-03-12 | Initial creation from full audit. 14 stories (MVP-01 through MVP-14). |
| 2026-03-12 | Added 15 stories (MVP-16 through MVP-30): block explorer deep links, credential template enhancement, metadata display, AI features (auto-descriptions, fraud detection, cost optimization), LinkedIn badges, individual self-verification, credits system, GCP deployment (Cloud Run, Secret Manager, Cloud Scheduler, Cloud KMS, CI/CD). Updated MVP-01 to target Google Cloud Run. Total: 29 stories. |
| 2026-03-12 | Removed MVP-19 (superseded by P8-S4/S5), removed MVP-22 (superseded by P8-S7/S8/S9). Updated MVP-23 to non-AI batch anchoring only. Updated MVP-24 with monthly credit allocations per tier (Free=50, Pro=500, Enterprise=5000). Total: 27 stories (2 removed as superseded). |
| 2026-03-14 | Doc sync audit: MVP-02 → PARTIAL (Sonner wired + 3 hooks have toasts, 4 hooks still missing). MVP-03 → COMPLETE (PrivacyPage + TermsPage + ContactPage exist + routed). MVP-04 → COMPLETE (PR #30 — ArkovaLogo, favicon.svg, og-image.svg, OG meta tags). MVP-05 → COMPLETE (ErrorBoundary + NotFoundPage exist + routed + Sentry wired). Totals: 3 complete, 1 partial, 23 not started. |
