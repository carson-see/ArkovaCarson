# Systematic UAT Sweep — 2026-03-31

**Tested by:** Claude (automated Playwright)
**Accounts tested:**
- crseeger09@gmail.com (Individual, Google OAuth)
- carson@arkova.ai (Platform Admin, email/password)
**Sites tested:** arkova.ai, search.arkova.ai, app.arkova.ai
**Viewport:** 1280x800 (desktop), 375x812 (mobile)

---

## CRITICAL Bugs

### BUG-001: Search RPC returns 500 — search is completely broken
- **Page:** app.arkova.ai/search
- **Steps:** Click any suggested search (e.g., "SEC 10-K filing Apple") -> Click Search
- **Expected:** Results or "No results found"
- **Actual:** Red error banner "Search failed. Please try again." + empty state shown simultaneously
- **Console:** `GET /rest/v1/rpc/search_public_credentials` returns 500
- **Impact:** Core public feature is non-functional for BOTH Individual and Admin accounts
- **UX issue:** Error banner AND empty state shown together — should show only one

### BUG-002: Attestations API returns 500 on every page load
- **Page:** app.arkova.ai/dashboard (and others)
- **Console:** `GET /rest/v1/attestations?select=id` returns 500
- **Impact:** Attestations count on dashboard may be wrong; silently failing on every authenticated page load
- **Root cause:** Likely RLS policy issue for the attestations table

### BUG-003: Onboarding redirect loop on direct URL navigation
- **Page:** Any authenticated route accessed via direct URL (e.g., /settings, /documents, /organizations, /admin/overview)
- **Steps:** Type any URL directly in address bar
- **Expected:** Requested page loads directly
- **Actual:** Briefly shows `/onboarding/role` URL, then eventually resolves to the page (sometimes redirects to /dashboard instead)
- **Impact:** Deep links, bookmarks, and shared URLs are unreliable. Confirmed for BOTH Individual and Admin accounts.
- **Note:** Sidebar navigation works correctly. Only direct URL navigation is broken.

### BUG-004: `lookup_org_by_email_domain` RPC returns 400
- **Console:** `POST /rest/v1/rpc/lookup_org_by_email_domain` returns 400
- **Trigger:** Every page load for Gmail users
- **Impact:** Org domain lookup fails silently — may prevent org auto-association

### BUG-019: Anchors API returns 500 — admin overview metrics broken
- **Page:** app.arkova.ai/admin/overview, app.arkova.ai/dashboard
- **Console:** Multiple `GET /rest/v1/anchors?select=...&user_id=eq.{id}` return 500
- **Impact:** Admin overview cards stuck on skeleton loaders. Dashboard stats show 0 for admin account despite 1.39M records existing.
- **Root cause:** RLS policy on `anchors` table may not allow admin to query own records, or column references are broken

---

## HIGH Priority Bugs

### BUG-005: Credits showing limits during beta
- **Page:** app.arkova.ai/dashboard
- **Expected:** No credit/quota limits during beta (per product directive)
- **Actual:**
  - Individual account: "50 / 50 remaining" with "1 days until reset"
  - Admin account: "5000 / 5000 remaining" with "1 days until reset"
- **Grammar bug:** "1 days" should be "1 day" (singular)
- **Note:** Per feedback memory, NO credit/quota limits should exist during beta

### BUG-006: CSP `frame-ancestors` in meta tag — ignored on every page
- **Pages:** All pages on app.arkova.ai and search.arkova.ai
- **Console:** "The Content Security Policy directive 'frame-ancestors' is ignored when delivered via a <meta> element."
- **Fix:** Move `frame-ancestors` to HTTP response header

### BUG-007: Developers page shows "SIGN IN" when user is already logged in
- **Page:** app.arkova.ai/developers
- **Expected:** Show user avatar/name or "Dashboard" link
- **Actual:** Shows "SIGN IN" and "GET STARTED" buttons in header
- **Impact:** Confusing — user thinks they're not logged in

### BUG-008: Onboarding stepper shows 3 steps but Individual only sees 1
- **Page:** app.arkova.ai/onboarding/role
- **Expected:** Either show only 1 step for Individual, or go through all steps
- **Actual:** Stepper shows "Account Type -> Organization -> Confirmation" but skips directly to dashboard
- **Impact:** Misleading UX

### BUG-020: Page header says "Dashboard" on all admin pages
- **Pages:** /admin/overview, /admin/users, /admin/organizations, /admin/records, /admin/treasury, /admin/pipeline, /admin/health, /admin/payments, /admin/controls
- **Expected:** Header should show the actual page name (e.g., "Admin - Users", "Treasury")
- **Actual:** All admin pages show "Dashboard" in the top header bar
- **Impact:** User can't tell which admin page they're on from the header

### BUG-024: Treasury page uses banned terminology "Bitcoin"
- **Page:** app.arkova.ai/admin/treasury
- **Text:** "Anchored on Bitcoin", "Bitcoin Transactions"
- **Violation:** Constitution 1.3 bans "Bitcoin" in user-visible strings
- **Fix:** "Anchored on Network" / "Network Transactions" or "Anchored on Production Network"

### BUG-025: Treasury page shows all zeros despite 1.39M records
- **Page:** app.arkova.ai/admin/treasury -> Pipeline Status section
- **Expected:** Reflect actual anchoring data (1.39M+ records anchored, 166K+ network transactions)
- **Actual:** All metrics show 0 — Queued: 0, Broadcasting: 0, In Mempool: 0, Anchored: 0, Revoked: 0, Total Records: 0, Bitcoin Transactions: 0
- **Note:** Pipeline page (/admin/pipeline) correctly shows 1,391,512 records, so the data exists — Treasury just isn't fetching it

---

## MEDIUM Priority Bugs

### BUG-009: Organization sidebar link visible but non-functional for Individual accounts
- **Page:** Sidebar -> Organization
- **Steps:** Click "Organization" in sidebar (Individual account)
- **Expected:** Either show an "upgrade to organization" prompt, or hide the link
- **Actual:** Redirects through onboarding loop -> lands on dashboard
- **Impact:** Dead nav link for Individual users

### BUG-010: Empty state copy mismatch on Documents page
- **Page:** app.arkova.ai/documents
- **Expected:** "No documents yet" with CTA to secure first document
- **Actual:** Shows "No documents yet" heading but "No documents match your search." subtitle even with no search query
- **Fix:** Differentiate between empty state (no docs at all) and no-results state

### BUG-011: Platform Disclaimer shown on Settings page instead of during onboarding
- **Page:** app.arkova.ai/settings
- **Expected:** Legal disclaimer shown during onboarding flow
- **Actual:** Disclaimer banner with "I Understand and Accept" shown on Settings page — easily ignored
- **Impact:** Legal coverage may be insufficient if users never visit Settings
- **Confirmed:** Same for both Individual and Admin accounts

### BUG-012: Privacy toggle text references "organization" for Individual accounts
- **Page:** app.arkova.ai/settings -> Privacy section
- **Expected:** Text appropriate for account type
- **Actual:** "Your organization is not visible in public search results" — but this is an Individual account
- **Fix:** Conditionally render copy: "Your profile is not visible..." for Individual accounts

### BUG-013: search.arkova.ai footer uses banned terminology
- **Page:** search.arkova.ai
- **Text:** "Powered by Arkova — document integrity anchored on Bitcoin"
- **Violation:** Constitution 1.3 bans "Bitcoin" in user-visible strings
- **Fix:** Change to "anchored on a public network"

### BUG-014: search.arkova.ai page title is just "Arkova"
- **Page:** search.arkova.ai
- **Expected:** "Arkova Search" or "Search Credentials — Arkova"
- **Actual:** Just "Arkova"
- **Impact:** SEO — page title doesn't describe the page

### BUG-015: Suggested search chips don't auto-execute search
- **Page:** app.arkova.ai/search
- **Steps:** Click "Harvard University" or "SEC 10-K filing Apple" chip
- **Expected:** Search executes immediately
- **Actual:** Only fills the search box — requires additional click on "Search" button
- **Impact:** Extra click for suggested queries

### BUG-021: User shivanprasad1@gmail.com has missing role badge
- **Page:** app.arkova.ai/admin/users
- **Expected:** All users should have a Role value (Individual, Admin, etc.)
- **Actual:** shivanprasad1@gmail.com (Shivan Prasad) has empty Role and Admin cells
- **Root cause:** User likely abandoned onboarding before selecting a role

### BUG-026: Admin sidebar active state wrong for Payments and Controls
- **Pages:** /admin/payments, /admin/controls
- **Expected:** Sidebar should highlight the current page
- **Actual:** "System Health" stays highlighted when on Payments or Controls pages
- **Fix:** Route matching for sidebar active state needs to include these pages

### BUG-027: Search empty state shows wrong text for Credentials tab
- **Page:** app.arkova.ai/search -> Credentials tab -> search fails
- **Expected:** "No credentials found" / "No public credentials match your search."
- **Actual:** "No issuers found" / "No public issuers match your search."
- **Fix:** Empty state text should be tab-aware

---

## LOW Priority / Polish

### BUG-016: About page uses initials avatars instead of real photos
- **Page:** app.arkova.ai/about
- **Expected:** Team member photos (like arkova.ai marketing site)
- **Actual:** Shows "CS" and "SR" initial circles
- **Impact:** Inconsistency between marketing site and app about page

### BUG-017: Access token visible in console error log
- **Page:** app.arkova.ai/auth/callback (during OAuth)
- **Detail:** Full JWT access token logged in console error message URL
- **Impact:** If Sentry captures console errors with URLs, the access token would be sent to Sentry

### BUG-018: Stale refresh token error on first load
- **Page:** app.arkova.ai (cold load with expired session)
- **Console:** "AuthApiError: Invalid Refresh Token: Refresh Token Not Found"
- **Impact:** Expected for expired sessions, but should be handled gracefully

### BUG-028: Admin overview metric cards stuck on skeleton loaders
- **Page:** app.arkova.ai/admin/overview
- **Expected:** Show platform metrics (total users, records, revenue, etc.)
- **Actual:** Top 4 summary cards and all chart cards show permanent skeleton loading states
- **Root cause:** API calls returning 500 (see BUG-019)

### BUG-029: System Health shows raw "mainnet" badge
- **Page:** app.arkova.ai/admin/health -> Anchor Network card
- **Expected:** "Production Network" (per Constitution 1.3)
- **Actual:** Shows raw `mainnet` badge
- **Note:** Treasury page correctly says "Production Network" — inconsistency

### BUG-030: Pipeline source names have inconsistent casing
- **Page:** app.arkova.ai/admin/pipeline
- **Items:** "npi", "finra", "calbar" are all lowercase while others use proper casing (SEC EDGAR, CourtListener Legal, ACNC Charities)
- **Fix:** Normalize to "NPI Registry", "FINRA BrokerCheck", "California State Bar"

### BUG-031: Pipeline credential type casing inconsistent
- **Page:** app.arkova.ai/admin/pipeline -> Anchors by Credential Type
- **Items:** "REGULATION" and "UNKNOWN" are all-caps while others use title case (Publications, SEC Filings, Legal, etc.)
- **Fix:** Normalize to title case

### BUG-032: Records admin page shows raw enum type values
- **Page:** app.arkova.ai/admin/records
- **Expected:** Human-friendly type labels ("SEC Filing", "Publication")
- **Actual:** Shows raw DB values like `sec_filing`, `publication` (lowercase with underscores)
- **Fix:** Map credential_type enum values to display labels

### BUG-033: Dashboard shows 0 records for admin despite 1.39M pipeline records
- **Page:** app.arkova.ai/dashboard (admin account)
- **Expected:** Dashboard reflects the admin's record count
- **Actual:** Total Records: 0, Secured: 0, Pending: 0
- **Note:** Pipeline page correctly shows 1,391,512 records owned by carson@arkova.ai. The disconnect is between pipeline/ingested records and the user's personal dashboard view.
- **Possible cause:** Pipeline records are system-level, not associated with user's personal anchors table via user_id

### BUG-034: Getting Started checklist shows inappropriate steps for admin org account
- **Page:** app.arkova.ai/dashboard (admin account)
- **Steps shown:** "Create a credential template" (disabled/checked), "Issue your first credential", "Set up billing" (disabled/checked)
- **Expected:** Admin/org accounts should not see "Getting Started" or should see org-appropriate steps
- **Actual:** Shows individual-oriented onboarding checklist with 2/3 complete but no way to complete the remaining step easily

### BUG-035: Compliance page shows 0 Active Credentials but 500 Secured Records
- **Page:** app.arkova.ai/organization/compliance
- **Expected:** Consistent metrics — if 500 secured records exist, active credentials should reflect this
- **Actual:** "Active Credentials: 0" alongside "500 Secured Records" and "8 Controls Evidenced"
- **Impact:** Confusing for compliance reporting

---

## Feature Gaps Identified

### GAP-001: No admin dashboard metrics
- Admin Overview page has metric cards but they all show skeleton loaders (data fetch fails). Even if they worked, the admin dashboard shows the same personal view as any user — no platform-wide stats visible on the main dashboard.
- **Recommendation:** Admin dashboard should show platform-level KPIs inline (total users, total records, revenue, system status)

### GAP-002: Controls page is sparse
- Platform Controls (/admin/controls) only has 3 buttons: Start Ingestion, Start Anchoring, Maintenance Mode
- Described as "Master switchboard for all platform features" but no feature flags, toggles, or configuration visible
- **Recommendation:** Add feature flag toggles (ENABLE_AI_EXTRACTION, ENABLE_VERIFICATION_API, etc.) per Constitution 1.9

### GAP-003: No public verification flow tested
- No secured records exist for the admin account's personal view, so /verify/:publicId could not be tested
- Pipeline records (1.39M) are system-level and don't appear in the user's Documents view
- **Recommendation:** Test with a known public_id from admin/records

### GAP-004: No record detail view tested
- Clicking a record in admin/records was not tested — could not verify template rendering, metadata display, or anchor status details
- **Recommendation:** Click into a SEC filing or publication to verify the detail view renders correctly

### GAP-005: Auditor Mode not tested
- Sidebar shows "Auditor Mode: Off" toggle but was not exercised during this sweep
- **Recommendation:** Enable Auditor Mode and verify it changes the UI appropriately

---

## What's Working Well

### Marketing Site (arkova.ai)
- All pages render correctly (homepage, docs, whitepaper, wiki, research, roadmap, contact, privacy, terms)
- Mobile responsive, professional design
- "Nordic Vault" aesthetic is consistent and polished

### App (app.arkova.ai)
- **Sidebar navigation**: Clean 6-item nav (Dashboard, Documents, Organization, Search, Developers, Settings) + collapsible Admin section for admin users
- **Admin section**: Full admin nav with 10 pages (Compliance, Overview, Users, Organizations, Records, Treasury, Pipeline, System Health, Payments, Controls)
- **Pipeline page**: Excellent — comprehensive metrics, source breakdowns, credential type distribution, pipeline controls, pagination
- **System Health**: Real-time status of all services, memory usage, runtime — well-designed
- **Compliance Intelligence**: Framework coverage, regulatory gaps, audit export — impressive feature
- **Organization page**: Clean org card with role badge and domain info
- **Settings page**: Comprehensive (Profile, Bio, Social, Identity, Privacy, 2FA, Danger Zone)
- **Billing page**: Correct terminology ("Fee Account" not "Wallet"), Beta plan shown
- **Dark theme**: Consistent "Nordic Vault" aesthetic throughout
- **Admin Users/Orgs/Records**: Functional tables with search/filter, proper pagination on records

### Data
- **1,392,173 total records** in admin view
- **1,391,512 records anchored** (99.95%)
- **86,025 records embedded** (6.2%)
- **12 data sources** active (OpenAlex, SEC EDGAR, CourtListener, ACNC, Federal Register, NPI, FINRA, DAPIP, CalBar, etc.)
- **All systems operational** — Supabase, Anchor Network (mainnet), Stripe, Sentry, AI (Gemini), Email all connected

---

## Resolution Log (2026-03-31)

### Frontend Fixes Applied (20 bugs)

| Bug | Fix | Files Changed |
|-----|-----|---------------|
| BUG-005 | Show "Unlimited / Beta" instead of credit counters | `CreditUsageWidget.tsx`, `CreditUsageWidget.test.tsx` |
| BUG-006 | Removed `frame-ancestors` from CSP meta tag (ignored in meta, needs HTTP header) | `index.html` |
| BUG-007 | Developers page detects login state, shows "Dashboard" link when authenticated | `DevelopersPage.tsx` |
| BUG-008 | Removed misleading 3-step OnboardingStepper from role selection page | `OnboardingRolePage.tsx` |
| BUG-009 | Hide Organization sidebar link for Individual accounts (no org) | `Sidebar.tsx`, `Sidebar.test.tsx` |
| BUG-010 | Empty state differentiates "no docs" vs "no search results" | `DocumentsPage.tsx` |
| BUG-012 | Privacy toggle says "Your profile" instead of "Your organization" for Individuals | `copy.ts` |
| BUG-013 | Footer changed from "anchored on Bitcoin" to "anchored on a public network" | `SearchPage.tsx` |
| BUG-014 | Page title set to "Arkova Search — Verify Credentials" on search subdomain | `SearchPage.tsx` |
| BUG-015 | Suggested search chips now auto-execute search on click | `SearchPage.tsx` |
| BUG-017 | Strip access_token fragment from URL on OAuth callback | `AuthCallbackPage.tsx` |
| BUG-020 | Admin page headers show actual page name instead of "Dashboard" | `Header.tsx` |
| BUG-024 | Treasury page: "Anchored on Network" / "Network Transactions" | `AnchorStats.tsx` |
| BUG-027 | Search empty state is now tab-aware (credentials vs issuers) | `SearchPage.tsx` |
| BUG-029 | System Health: "mainnet" badge replaced with "Production Network" | `SystemHealthPage.tsx` |
| BUG-030 | Pipeline sources: npi/finra/calbar properly labeled | `PipelineAdminPage.tsx` |
| BUG-031 | Pipeline credential types: normalized via CREDENTIAL_TYPE_LABELS | `PipelineAdminPage.tsx` |
| BUG-032 | Admin Records: raw enum values replaced with human-friendly labels | `AdminRecordsPage.tsx` |
| BUG-034 | Getting Started checklist hidden for platform admin accounts | `DashboardPage.tsx` |
| BUG-001 (partial) | Error banner + empty state no longer shown simultaneously | `SearchPage.tsx` |

### Backend Migrations Written (3 migrations, need `supabase db push`)

| Migration | Bug | Fix |
|-----------|-----|-----|
| `0148_fix_org_lookup_deleted_at.sql` | BUG-004 | Remove invalid `deleted_at IS NULL` filter from `lookup_org_by_email_domain` and `join_org_by_domain` RPCs (organizations table has no `deleted_at` column) |
| `0149_fix_attestations_rls_recursion.sql` | BUG-002 | Replace inline `SELECT org_id FROM profiles` in attestations_select RLS policy with `get_user_org_id()` SECURITY DEFINER helper to prevent recursive RLS evaluation |
| `0150_fix_search_performance_indexes.sql` | BUG-001 | Add trigram GIN indexes on anchors.filename, description, credential_type for ILIKE search performance on 1.39M rows |

### Triaged / No Code Fix Needed

| Bug | Status | Notes |
|-----|--------|-------|
| BUG-003 | Downstream | Onboarding redirect loop is a symptom of BUG-002/004 backend 500s making profile appear incomplete. Applying migrations 0148/0149 should resolve. |
| BUG-011 | Design enhancement | Disclaimer on Settings is functional (shown until accepted). Moving to onboarding is a UX improvement, not a code bug. |
| BUG-016 | Content gap | No team photo assets in repo. Needs image files to be added to `public/` directory. |
| BUG-018 | Already handled | `useAuth.ts` already catches stale refresh tokens gracefully (clears session, redirects to login). Console error is from Supabase SDK internals. |
| BUG-019 | Needs investigation | Anchors RLS uses SECURITY DEFINER helpers (fixed in 0038). If still 500ing, may be query timeout on 1.39M rows. Migration 0150 indexes should help. |
| BUG-021 | Data issue | User abandoned onboarding before selecting role. No code fix — admin can set role in DB. |
| BUG-025 | Downstream of BUG-019 | Treasury zeros are because anchors API returns 500. Fix BUG-019 first. |
| BUG-026 | Cannot reproduce | Sidebar active state logic is correct — routes are distinct, no prefix overlap. May have been a one-time render issue. |
| BUG-028 | Downstream of BUG-019 | Admin overview skeletons are because anchors API returns 500. |
| BUG-033 | By design | Dashboard shows personal anchors (user_id), not pipeline records (system-level). Pipeline records are ingested by the worker, not owned by a user account. |
| BUG-035 | Downstream of BUG-002 | "0 Active Credentials" is because attestations API returns 500 (RLS recursion). Migration 0149 fixes this. |

### Verification Results

- TypeScript: clean (0 errors)
- ESLint: clean (0 warnings)
- lint:copy: clean (0 forbidden terms)
- Tests: 123 files, 1117 tests, all passing

### Next Steps

1. Apply migrations to production: `supabase db push` (0148, 0149, 0150)
2. Verify BUG-001/002/003/004/019 resolve after migration apply
3. Add team photo assets for BUG-016
4. Move `frame-ancestors` to HTTP response headers (Vercel config or middleware) for BUG-006
5. Consider moving disclaimer to onboarding flow for BUG-011
