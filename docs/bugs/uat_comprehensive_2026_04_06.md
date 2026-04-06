# UAT Comprehensive Review — 2026-04-06

**Reviewer:** Claude (automated UAT)
**Environment:** app.arkova.ai (production)
**Browser:** Chrome, macOS
**Date:** April 6, 2026
**PR:** fix/uat-bugs-2026-04-06
**Jira:** SCRUM-488 through SCRUM-501 (14 bugs filed)
**Session:** Part 1 + Part 2 combined

---

## Summary

Tested all major surfaces of app.arkova.ai across desktop (1440px) and mobile (375px). The application is polished, feature-rich, and mostly functional. The primary blocker is **worker CORS misconfiguration** which prevents the frontend from communicating with the Cloud Run worker, breaking all admin dashboards and API key management.

**Total bugs found:** 14
- HIGH: 4
- MEDIUM: 6
- LOW: 4

---

## Bug Log

### HIGH Severity

| ID | Page | Description | Root Cause |
|----|------|-------------|------------|
| BUG-UAT-02 | `/verify/attestation/*` | **Attestation detail page broken** — Clicking attestation from Documents page navigates to `/verify/attestation/ARK-ATT-2026-94008AC0` which shows "Attestation Not Found" with worker connection error. Also navigates away from authenticated app context. | Worker unreachable (CORS) or attestation lookup route broken |
| BUG-UAT-03 | Documents | **Attestation stuck in Pending 15+ days** — "VERIFICATION — Masters in Business Administration" by ACME University has been Pending since Mar 22, 2026. Anchoring pipeline should have processed this. | Anchoring pipeline not running or credential missed in batch |
| BUG-UAT-12 | All admin pages, API Keys | **Worker CORS not configured** — The Cloud Run worker at `arkova-worker-270018525501.us-central1.run.app` does not return `Access-Control-Allow-Origin` headers. The worker IS healthy (`/health` returns 200, Supabase OK, mainnet), but the browser blocks all cross-origin requests from `app.arkova.ai`. This is the root cause of ALL "Unable to connect to server" errors across admin pages. | Missing CORS middleware or CORS_ALLOWED_ORIGINS env var not set on Cloud Run |
| BUG-UAT-13 | Dashboard → Issue Credential | **Dashboard "Issue Credential" button opens wrong dialog** — The "Issue Credential" button on the dashboard opens the "Secure Document" upload dialog instead of the credential issuance form. The correct Issue Credential dialog (with credential type dropdown, label, dates, recipient) is only accessible from the Directory/Organization page. | Wrong click handler or shared dialog component routing |

### MEDIUM Severity

| ID | Page | Description |
|----|------|-------------|
| BUG-UAT-01 | Dashboard | **Dashboard stats inconsistency** — Stats show 0 Total Records, 0 Secured, 0 Pending but Monthly Usage shows 13,641 records. Confusing whether stats are personal vs org-level. |
| BUG-UAT-04 | Search | **Search suggested chips return no results** — "Harvard University" chip auto-fills and searches but returns "No issuers found." Suggested chips should only show values that return results. |
| BUG-UAT-06 | Organization | **Org records table shows 0 despite 1.4M header count** — Organization page header says "1,409,444 records" but the Records table shows "0 records found". Header count comes from a different query than the table. |
| BUG-UAT-07 | Organization | **Org page missing "About" section** — Home tab has no visible About/description section. The description from Settings should be visible on the Home tab. |
| BUG-UAT-09 | Issue Credential dialog | **No validation feedback on submit without credential type** — Clicking "Issue Credential" with all fields filled except Credential Type shows no error message. The button is disabled when no document is uploaded (correct), but no visual feedback for missing credential type. |
| BUG-UAT-11 | `/admin/compliance` | **Compliance page returns 404** — "Compliance" link exists in admin sidebar but `/admin/compliance` returns 404. Route not implemented. |

### LOW Severity

| ID | Page | Description |
|----|------|-------------|
| BUG-UAT-05 | Search | **Stale search results on tab switch** — Switching to "Verify Document" tab still shows "No issuers found" from previous Issuers search below the drop zone. |
| BUG-UAT-08 | Organization | **Org website not clickable** — "arkova.ai" in org header meta row is plain text, not a hyperlink. |
| BUG-UAT-10 | `/settings/api-keys` | **API Keys page shows connection error** — "Unable to load API keys" error banner, plus duplicate error at bottom. This is a symptom of BUG-UAT-12 (CORS). |
| BUG-UAT-14 | Public issuer page | **HTML entities in record titles** — One record title shows raw HTML `<sub>2</sub>` as literal text instead of rendering the subscript. |

---

## Pages Tested

### Authenticated Pages (Desktop 1440px + Mobile 375px)

| Page | Route | Status | Notes |
|------|-------|--------|-------|
| Dashboard | `/dashboard` | PASS (with bugs) | Layout good, stats inconsistency (BUG-01), Issue Credential button wrong (BUG-13) |
| Documents | `/documents` | PASS (with bugs) | All tabs work, search works, attestation detail broken (BUG-02, BUG-03) |
| Directory/Organization | `/organization` | PASS (with bugs) | Header, People, Settings tabs work. Records table empty (BUG-06) |
| Search | `/search` | PASS (with bugs) | Three tabs work, chip suggestions broken (BUG-04) |
| Developers | `/developers` | PASS | Excellent page — hero, features, code examples, SDK tabs, x402 payments, pricing table, MCP server |
| Settings | `/settings` | PASS | Profile, Bio, Social Profiles, Identity, Privacy, Identity Verification, 2FA, Org Settings, Danger Zone |
| Settings > API Keys | `/settings/api-keys` | FAIL | CORS error prevents loading (BUG-12) |
| Settings > Webhooks | `/settings/webhooks` | PASS | Clean empty state with Add Endpoint button |

### Admin Pages

| Page | Route | Status | Notes |
|------|-------|--------|-------|
| Overview | `/admin/overview` | PARTIAL | Layout correct, all data shows 0 due to CORS (BUG-12) |
| Users | `/admin/users` | PARTIAL | Search + filter UI correct, no data due to CORS |
| Organizations | `/admin/organizations` | NOT TESTED | Link had encoded href |
| Records | `/admin/records` | PARTIAL | Search + filters correct, no data due to CORS |
| Treasury | `/admin/treasury` | PARTIAL | Good layout — Fee Account Balance, Pipeline Status, Network Status (Production Network). CORS blocks data. |
| Pipeline | `/admin/pipeline` | PASS | Stats + Pipeline Controls (EDGAR, USPTO, Fed Register, OpenAlex, DAPIP, ACNC fetch buttons) |
| System Health | `/admin/health` | PARTIAL | Service status cards (Supabase, Anchor Network, Stripe, Sentry, AI, Email). Worker offline. |
| Payments | `/admin/payments` | PASS | x402 Payment Analytics — Total Revenue, Revenue by Endpoint, Recent Payments |
| Controls | `/admin/controls` | PASS | Quick Actions (Start Ingestion, Start Anchoring, Maintenance Mode) |
| Compliance | `/admin/compliance` | FAIL | 404 — route not implemented (BUG-11) |

### Public Pages

| Page | Route | Status | Notes |
|------|-------|--------|-------|
| About | `/about` | PASS | Professional page with stats, feature cards, Team section |
| Privacy | `/privacy` | PASS | Complete privacy policy with Data Retention link |
| Terms | `/terms` | PASS | Complete ToS with Verification Scope section |
| Verify | `/verify/:publicId` | PASS | Excellent verification page — ACTIVE badge, metadata, lifecycle, provenance timeline, proof download, disclaimer |
| Issuer | `/issuer/:orgId` | PASS | Public org page — stats, record types chart, recent records with Verify links |
| 404 | Any invalid route | PASS | Clean 404 with shield icon, helpful navigation links |

### API Endpoints (curl)

| Endpoint | Method | Status | Response |
|----------|--------|--------|----------|
| `/health` | GET | 200 | `{"status":"healthy","version":"0.1.0","network":"mainnet","checks":{"supabase":"ok"}}` |
| `/api/v1/verify/:publicId` | GET | 402 | x402 payment required (correct for unauthenticated) |
| `/api/v1/verify/batch` | POST | 401 | `{"error":"authentication_required"}` (correct) |
| `/api/v1/search` | GET | 404 | Route not found |

### Responsive (375px Mobile)

| Page | Status | Notes |
|------|--------|-------|
| Dashboard | PASS | Sidebar collapses to hamburger, stats stack vertically |
| About | PASS | Stats grid 2x2, text wraps correctly |
| Verify | PASS | Clean layout, no overflow |

---

## Terminology Compliance

Checked against Constitution 1.3 banned terms:
- "Fee Account Balance" (not Wallet) — PASS
- "Production Network" (not Mainnet) — PASS
- "Network Observed Time" terminology — not tested (no anchor detail visible)
- "Fingerprint" (not Hash) — PASS (used in Document Fingerprint section)
- No banned terms observed in UI copy

---

## Key Recommendations

### P0 — Fix Immediately
1. **CORS on Cloud Run worker** (BUG-UAT-12) — Add `Access-Control-Allow-Origin: https://app.arkova.ai` (or use `CORS_ALLOWED_ORIGINS` env var). This is blocking ALL admin functionality and API key management.

### P1 — Fix Before Beta
2. **Attestation detail page** (BUG-UAT-02) — Either fix the attestation lookup route or ensure it stays within the authenticated app context.
3. **Stuck attestation** (BUG-UAT-03) — Investigate why the MBA attestation has been Pending for 15+ days.
4. **Dashboard Issue Credential button** (BUG-UAT-13) — Should open the credential issuance form, not the document upload dialog.
5. **Compliance admin page** (BUG-UAT-11) — Either implement the page or remove the sidebar link.

### P2 — Fix Before Launch
6. **Dashboard stats vs Monthly Usage inconsistency** (BUG-UAT-01)
7. **Search chips that return no results** (BUG-UAT-04)
8. **Org records table showing 0** (BUG-UAT-06)
9. **Issue Credential validation feedback** (BUG-UAT-09)

### P3 — Polish
10. **Org About section** (BUG-UAT-07)
11. **Org website link** (BUG-UAT-08)
12. **HTML entities in record titles** (BUG-UAT-14)
13. **Stale search results on tab switch** (BUG-UAT-05)

---

## What Was NOT Tested

- File upload (document upload, CSV bulk upload) — Chrome MCP cannot interact with file dialogs
- Auth flows (signup, login, forgot password, logout, MFA) — would require incognito session
- Stripe billing/checkout — no test cards available
- Revocation flow — no credentials available to revoke
- LinkedIn badge/share functionality
- QR codes on record detail pages
- Email notifications (credential receipt)
- Webhook creation and testing
- API key creation and usage
- Data retention policy page at `/privacy/data-retention`
- AI Metrics admin page (route unknown)
