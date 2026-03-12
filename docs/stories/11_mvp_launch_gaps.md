# MVP Launch Gap Stories
_Last updated: 2026-03-12 ~6:00 AM EST_

## Group Overview

These 14 stories were identified during the 2026-03-12 full audit. They represent gaps between the current codebase and a fully testable MVP on Bitcoin Signet testnet. The audit document lives at `docs/audit/2026-03-12_full_audit.md`.

**Priority:** These are launch-blocking for testnet MVP. They should be completed before Phase 1.5 (P4.5 Verification API) or P8 (AI Implementation).

### Completion Summary

| Status | Count |
|--------|-------|
| COMPLETE | 0 |
| PARTIAL | 0 |
| NOT STARTED | 14 |

---

## MVP-01: Worker Production Deployment

**Status:** NOT STARTED
**Priority:** CRITICAL (blocks testnet launch)
**Depends on:** P7-TS-05 (Bitcoin chain client)

### What It Delivers
Deploy the Express worker service to a production host (Railway, Fly.io, or Render) so the anchor processing pipeline, Stripe webhooks, and cron jobs can run outside localhost.

### Acceptance Criteria
- [ ] Worker deployed to production host with health check endpoint responding
- [ ] Environment variables configured (Supabase service role, Stripe keys, Bitcoin treasury WIF)
- [ ] Cron jobs running (anchor processing, webhook retries, report generation)
- [ ] Stripe webhook URL configured and receiving events
- [ ] `ENABLE_PROD_NETWORK_ANCHORING=true` on deployment (Signet)
- [ ] CI/CD pipeline deploys on merge to main
- [ ] Logs accessible for debugging

### Files
- `services/worker/` (existing — no code changes needed)
- New: deployment config (Dockerfile or platform config)
- New: `.github/workflows/deploy-worker.yml`

### Security Notes
- Service role key must be in platform secrets, never in code
- `BITCOIN_TREASURY_WIF` loaded from env, never logged
- Health endpoint must not expose internal state

---

## MVP-02: Toast/Notification System

**Status:** NOT STARTED
**Priority:** HIGH (UX gap)
**Depends on:** None

### What It Delivers
Global toast notification system using Sonner. Currently only WebhookSettings has inline toasts — all other actions (anchor creation, revocation, profile save, errors) provide no feedback.

### Acceptance Criteria
- [ ] Sonner `<Toaster />` added to App.tsx (global)
- [ ] Success toast on: anchor creation, profile save, org settings save, member invite, credential template CRUD
- [ ] Error toast on: all Supabase query failures, validation errors
- [ ] Warning toast on: approaching quota limit
- [ ] Toast styling matches Arkova brand (Steel Blue accent)

### Files
- `src/App.tsx` — add `<Toaster />`
- `src/hooks/useAnchors.ts` — add toast calls
- `src/hooks/useProfile.ts` — add toast calls
- `src/hooks/useOrganization.ts` — add toast calls
- All form submission handlers

---

## MVP-03: Legal Pages (Privacy, Terms, Contact)

**Status:** NOT STARTED
**Priority:** HIGH (dead links in production)
**Depends on:** None

### What It Delivers
Static legal pages at `/privacy`, `/terms`, and `/contact`. Currently these routes are linked from PublicVerifyPage footer and AuthLayout but return 404.

### Acceptance Criteria
- [ ] `/privacy` route renders Privacy Policy page
- [ ] `/terms` route renders Terms of Service page
- [ ] `/contact` route renders Contact page with support@arkova.io
- [ ] All three pages are public (no auth required)
- [ ] Footer links in PublicVerifyPage and AuthLayout work
- [ ] Pages use consistent layout with Arkova header/footer
- [ ] Content is placeholder but professional (can be updated with legal review later)

### Files
- New: `src/pages/PrivacyPage.tsx`
- New: `src/pages/TermsPage.tsx`
- New: `src/pages/ContactPage.tsx`
- `src/lib/routes.ts` — add PRIVACY, TERMS, CONTACT
- `src/App.tsx` — add routes

---

## MVP-04: Brand Assets (Logo, Favicon, OG Tags)

**Status:** NOT STARTED
**Priority:** HIGH (professional appearance)
**Depends on:** None

### What It Delivers
Real brand assets replacing the Shield icon placeholder. Favicon, OG meta tags for social sharing, and logo component.

### Acceptance Criteria
- [ ] SVG logo in `public/` directory
- [ ] Favicon set (favicon.ico + apple-touch-icon + manifest icons)
- [ ] `index.html` has: meta description, OG title/description/image, Twitter card tags
- [ ] Logo component replaces Shield icon in Sidebar and PublicVerifyPage header
- [ ] Logo works on both light and dark backgrounds

### Files
- New: `public/logo.svg`, `public/favicon.ico`, `public/apple-touch-icon.png`
- `index.html` — add meta tags
- `src/components/layout/Sidebar.tsx` — replace Shield with Logo
- `src/components/public/PublicVerifyPage.tsx` — replace Shield with Logo
- New: `src/components/ui/Logo.tsx` (brand logo component)

---

## MVP-05: Error Boundary + 404 Page

**Status:** NOT STARTED
**Priority:** HIGH (error handling)
**Depends on:** None

### What It Delivers
React Error Boundary wrapping the app to catch render crashes, plus a proper 404 page for unknown routes.

### Acceptance Criteria
- [ ] Error boundary catches React render errors and shows recovery UI
- [ ] 404 page at catch-all route with "Go to Dashboard" link
- [ ] Error boundary logs errors (console in dev, could be Sentry later)
- [ ] Both pages match Arkova brand styling

### Files
- New: `src/components/layout/ErrorBoundary.tsx`
- New: `src/pages/NotFoundPage.tsx`
- `src/App.tsx` — wrap with ErrorBoundary, add `*` catch-all route
- `src/lib/routes.ts` — add NOT_FOUND

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

**Status:** NOT STARTED
**Priority:** MEDIUM (usability)
**Depends on:** None

### What It Delivers
Responsive sidebar with hamburger menu on mobile. Currently the sidebar is fixed-width and unusable on small screens.

### Acceptance Criteria
- [ ] Sidebar collapses to hamburger menu on screens < 768px
- [ ] Mobile menu opens as overlay or slide-in drawer
- [ ] All navigation items accessible on mobile
- [ ] Dashboard stats grid stacks on mobile (1 column)
- [ ] Tables horizontally scroll on mobile
- [ ] Touch-friendly tap targets (min 44px)

### Files
- `src/components/layout/Sidebar.tsx` — responsive behavior
- `src/components/layout/AppShell.tsx` — mobile layout
- New: `src/components/layout/MobileNav.tsx` (hamburger menu)

---

## MVP-08: Onboarding Progress Stepper

**Status:** NOT STARTED
**Priority:** MEDIUM (usability)
**Depends on:** P2-TS-0X (onboarding routes)

### What It Delivers
Visual progress indicator in the onboarding flow showing which step the user is on (1. Role Selection → 2. Org Setup → 3. Review).

### Acceptance Criteria
- [ ] Step indicator visible on all onboarding pages
- [ ] Current step highlighted, completed steps marked
- [ ] Steps: Select Role → Organization Setup → Review
- [ ] Back button to navigate to previous step
- [ ] Progress persisted in URL or state (refresh doesn't lose progress)

### Files
- New: `src/components/onboarding/OnboardingProgress.tsx`
- `src/components/onboarding/RoleSelector.tsx` — integrate stepper
- `src/components/onboarding/OrgOnboardingForm.tsx` — integrate stepper
- `src/components/onboarding/ManualReviewGate.tsx` — integrate stepper

---

## MVP-09: Records Pagination + Search

**Status:** NOT STARTED
**Priority:** MEDIUM (scalability)
**Depends on:** P3-TS-01

### What It Delivers
Pagination and search for the records list. Currently all records load at once which won't scale.

### Acceptance Criteria
- [ ] Records list paginates (25 per page default)
- [ ] Previous/Next page controls
- [ ] Search by document name or fingerprint
- [ ] Filter by status (PENDING, SECURED, REVOKED)
- [ ] Sort by date (newest first default)
- [ ] URL params preserve page/search state on refresh

### Files
- `src/components/records/RecordsList.tsx` — add pagination + search
- `src/hooks/useAnchors.ts` — add pagination params to query

---

## MVP-10: Marketing Website (arkova.ai)

**Status:** NOT STARTED
**Priority:** MEDIUM (go-to-market)
**Depends on:** MVP-04 (brand assets)

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

**Status:** NOT STARTED
**Priority:** HIGH (billing completeness)
**Depends on:** P7-TS-02 (Stripe checkout — partial)

### What It Delivers
Complete the Stripe billing flow with plan upgrades, downgrades, and cancellations. This is the remaining work from CRIT-3.

### Acceptance Criteria
- [ ] Users can upgrade from Free to Pro/Enterprise
- [ ] Users can downgrade (effective at end of billing period)
- [ ] Users can cancel subscription
- [ ] Entitlements adjust immediately on upgrade, at period end on downgrade
- [ ] Webhook handlers process `customer.subscription.updated` and `customer.subscription.deleted`
- [ ] UI shows current plan and change options in Settings

### Files
- `services/worker/src/stripe/handlers.ts` — subscription change handlers
- `src/pages/SettingsPage.tsx` — plan management UI
- `src/hooks/useBilling.ts` — plan change mutations

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

## Change Log

| Date | Change |
|------|--------|
| 2026-03-12 | Initial creation from full audit. 14 stories (MVP-01 through MVP-14). |
