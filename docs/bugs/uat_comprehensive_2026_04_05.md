# UAT Comprehensive Click-Through Report — 2026-04-05

> **Tester:** Claude (automated UAT)
> **Environment:** Production — app.arkova.ai
> **Date:** 2026-04-05
> **Account:** Carson Seeger (carson@arkova.ai, Organization Administrator)
> **Method:** Full click-through of every sidebar page, button, and user flow

---

## Executive Summary

**Pages tested:** 20+ (dashboard, documents, directory, search, developers, settings, credential templates, webhooks, API keys, billing, organization, admin overview, treasury, pipeline, system health, payments, controls, compliance, public verification, attestation verification)

**Overall health:** Core app structure is solid. Navigation, sidebar, auth guards, settings, billing, compliance pages all function correctly. **Critical issues found with search functionality and worker API endpoints.**

| Severity | Count |
|----------|-------|
| **HIGH** | 3 |
| **MEDIUM** | 4 |
| **LOW** | 3 |
| **Total** | 10 |

---

## Bug Findings

### HIGH SEVERITY

#### BUG-UAT5-01: Public search returns "Search failed" — no RPC calls made
- **Severity:** HIGH
- **Page:** `/search` (all 3 tabs: Issuers, Credentials, Verify Document)
- **Steps to reproduce:**
  1. Navigate to app.arkova.ai/search
  2. Type any query (e.g., "Harvard University") or click a suggestion chip
  3. Click Search or press Enter
- **Expected:** Search results displayed
- **Actual:** Red error message: "Search failed. Please try again."
- **Root cause investigation:** Network analysis shows **zero Supabase RPC calls** are made when clicking Search. The error is caught client-side before any HTTP request. Both `search_public_issuers` and `search_public_credentials` RPCs exist in database.types.ts. The `supabase.rpc()` call at `SearchPage.tsx:149-150` uses aggressive type casting that may cause a runtime TypeError, caught silently at line 164. The `usePublicSearch.ts:66` uses `(supabase.rpc as any)` which also fails.
- **Fix needed:** Add `console.error` in catch blocks to surface the actual error. Check if Supabase client `.rpc()` method signature has changed. Possibly regenerate database.types.ts.

#### BUG-UAT5-02: Treasury page — "Unable to fetch balance" and "Unable to fetch fee rates"
- **Severity:** HIGH
- **Page:** `/admin/treasury`
- **Steps to reproduce:** Navigate to Admin > Treasury
- **Expected:** Fee Account Balance and Network Fee Rates displayed
- **Actual:** "Unable to fetch balance" and "Unable to fetch fee rates" errors. Pipeline Status shows all zeros despite Admin Overview showing 1.4M+ records.
- **Root cause:** Worker admin stats endpoints failing. System Health confirms worker is running (48h uptime), so this is likely an auth/endpoint issue with the treasury API calls.

#### BUG-UAT5-03: Pipeline page shows all zeros despite 1.4M+ records
- **Severity:** HIGH
- **Page:** `/admin/pipeline`
- **Steps to reproduce:** Navigate to Admin > Pipeline
- **Expected:** Records Ingested, Records Anchored, Pending Anchoring, Records Embedded should show actual counts
- **Actual:** All show 0. "No records ingested yet" and "No anchor data available" empty states.
- **Root cause:** Same as BUG-UAT5-02 — worker admin stats endpoints not returning data. Admin Overview page shows correct data (1,408,401 records, 1,400,492 SECURED) suggesting the Overview queries Supabase directly while Pipeline/Treasury query the worker.

### MEDIUM SEVERITY

#### BUG-UAT5-04: API Keys page shows "authentication_required" error
- **Severity:** MEDIUM
- **Page:** `/settings/api-keys`
- **Steps to reproduce:** Navigate to Settings > API Keys
- **Expected:** API key list with no errors
- **Actual:** API key cards display correctly, but an additional card at the bottom shows "authentication_required" error icon
- **Root cause:** The API usage/stats endpoint on the worker returns 401, and the error is displayed as a card rather than hidden gracefully.

#### BUG-UAT5-05: Developers page has ~600px empty gap below metrics
- **Severity:** MEDIUM
- **Page:** `/developers`
- **Steps to reproduce:** Navigate to Developers page and scroll below the traction metrics (1.39M+, 320K+, etc.)
- **Expected:** Feature cards appear immediately below metrics
- **Actual:** ~600px empty dark gap between metrics and feature cards. The 3 feature card headers are barely visible at the very bottom, then the page ends with another empty area.
- **Root cause:** Layout/CSS issue — likely a `min-height` or spacing issue in the developer page sections.

#### BUG-UAT5-06: Verification page for revoked record — missing sections
- **Severity:** MEDIUM
- **Page:** `/verify/ARK-ACD-Z9NMCY`
- **Steps to reproduce:** Open a revoked credential's public verification page
- **Expected:** Full page with revocation details, network receipt, share options, footer
- **Actual:** Page ends abruptly after the Revocation Details banner. No network receipt section, no share/LinkedIn buttons, no footer.
- **Root cause:** The verification page may not be rendering sections below the revocation banner — either conditional rendering hides them for revoked records, or a rendering error occurs.

#### BUG-UAT5-07: Dashboard vs Billing metrics inconsistency
- **Severity:** MEDIUM
- **Page:** `/dashboard` vs `/billing`
- **Steps to reproduce:** Compare Monthly Usage on Dashboard (12,575 records) with Billing page (Records secured: 0)
- **Expected:** Consistent metrics or clearly labeled different metrics
- **Actual:** Dashboard shows "12,575 records this month" under Monthly Usage, but Billing shows "Records secured: 0"
- **Root cause:** Dashboard may show platform-wide API usage while Billing shows user-specific records. The labels are confusing.

### LOW SEVERITY

#### BUG-UAT5-08: Attestation stuck in "Anchoring in Progress" for 2+ weeks
- **Severity:** LOW (data issue, not code bug)
- **Page:** `/verify/attestation/ARK-ATT-2026-94008AC0`
- **Details:** Attestation created Mar 22, 2026 still shows "Anchoring in Progress" status. Either the worker didn't process it, or there's a stuck job.
- **Fix:** Investigate attestation_anchor job for this record. May need manual re-queue.

#### BUG-UAT5-09: Verification page shows raw ISO 8601 date format
- **Severity:** LOW
- **Page:** `/verify/ARK-ACD-Z9NMCY`
- **Details:** "ISSUED AT" shows "2026-04-01T00:00:00Z" instead of human-readable format like "Apr 1, 2026"
- **Fix:** Apply `formatDate()` or `toLocaleDateString()` to the issued_at field in PublicVerification.tsx

#### BUG-UAT5-10: Organization page shows "— records" instead of count
- **Severity:** LOW
- **Page:** `/organizations/{orgId}`
- **Details:** Below the org name, "— records" shows a dash instead of "0 records" or the actual count
- **Fix:** Handle null/undefined case in the records count display

---

## Pages Verified Working (No Issues Found)

| Page | Status |
|------|--------|
| Dashboard (layout, stats, empty state) | PASS |
| Documents (tabs, list, attestation link) | PASS |
| Settings > Profile (name, email, role) | PASS |
| Settings > Bio (textarea, char counter) | PASS |
| Settings > Social Profiles (LinkedIn, X, GitHub, Website) | PASS |
| Settings > Identity (User ID, Org ID, copy buttons) | PASS |
| Settings > Privacy (public profile toggle) | PASS |
| Settings > Identity Verification (Verified badge) | PASS |
| Settings > Two-Factor Authentication (Enable 2FA button) | PASS |
| Settings > Danger Zone (Delete Account button) | PASS |
| Settings > Sign Out | PASS |
| Credential Templates (list, add, edit, delete, toggle) | PASS |
| Webhooks (empty state, Add Endpoint) | PASS |
| API Keys (list, create, revoke, scope badges) | PASS (except #04) |
| Billing & Plans (plan, usage, fee account, history) | PASS |
| Admin Overview (stats cards, records by status) | PASS |
| Admin System Health (all green, services connected) | PASS |
| Admin Payments (x402 analytics) | PASS |
| Admin Controls (quick actions) | PASS |
| Admin Compliance (Nessie, frameworks, export) | PASS |
| Organization page (logo, members, tabs, search, bulk upload) | PASS |
| Secure Document modal (file upload, privacy notice) | PASS |
| Attestation detail page (public, details, fingerprint) | PASS |
| Auth guard (login redirect when authenticated) | PASS |

---

## Potential Issues (Non-Bug)

1. **Admin Overview shows "0 Total Organizations"** — may be correct if "organizations" means multi-user orgs vs individual accounts, but worth verifying the query.
2. **Dashboard "Loading" skeleton** — briefly shows gray loading bars for the Monthly Usage card on initial load, then resolves. Minor UX issue.

---

## Recommendations

1. **P0 — Fix public search** (BUG-UAT5-01): This is the most user-visible broken feature. Add error logging in catch blocks, verify the Supabase RPC calls work, and test end-to-end.
2. **P1 — Fix worker admin endpoints** (BUG-UAT5-02, 03): Treasury/Pipeline stats are critical for ops monitoring. Verify the worker auth flow for admin stats endpoints.
3. **P1 — Fix API Keys auth error** (BUG-UAT5-04): Show the error gracefully or hide the usage card when the worker is unreachable.
4. **P2 — Fix Developers page layout** (BUG-UAT5-05): CSS fix for the empty gap.
5. **P2 — Fix verification page for revoked records** (BUG-UAT5-06): Ensure all sections render.
6. **P3 — Fix date formatting and minor display issues** (BUG-UAT5-07, 09, 10).
