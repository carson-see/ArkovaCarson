# Arkova Unified Backlog — Single Source of Truth
_Last updated: 2026-03-16 | Re-prioritized each session per CLAUDE.md rules_

> **Rule:** All backlog items — stories, bugs, security findings, operational tasks, GEO items — exist in this single document. Prioritized and re-prioritized each session.

---

## Summary

| Category | Total | Done | Open | Blocking Launch? |
|----------|-------|------|------|:----------------:|
| Stories (NOT STARTED) | 13 | — | 13 | No (post-launch) |
| Stories (PARTIAL) | 4 | — | 4 | 1 blocking (INFRA-07) |
| Security Findings | 12 | 10 fixed | 2 | **YES** (AUTH-01, SEC-01) |
| UAT Bugs | 38 | 10 | 28 | Some HIGH |
| Operational Tasks | 7 | 0 | 7 | **YES** |
| Code TODOs | 1 | — | 1 | No |
| **Total Open Items** | | | **55** | |

---

## TIER 1: LAUNCH BLOCKERS (must fix before any user touches production)

### Security (from CISO audit — `docs/security/launch_readiness_security_audit.md`)

| # | ID | Severity | Issue | File | Status |
|---|-----|----------|-------|------|--------|
| ~~1~~ | ~~PII-01~~ | ~~**CRITICAL**~~ | ~~`actor_email` plaintext in append-only `audit_events` — GDPR Art. 17 violation~~ | ~~migration 0061~~ | ~~**FIXED** (migration 0061 — null_audit_pii_fields trigger + backfill)~~ |
| ~~2~~ | ~~PII-02~~ | ~~**CRITICAL**~~ | ~~No right-to-erasure — no account deletion, no anonymization RPC~~ | ~~migration 0061 + 0065, account-delete.ts, DeleteAccountDialog.tsx~~ | ~~**FIXED** (anonymize_user_data RPC, delete_own_account RPC, worker endpoint, UI)~~ |
| ~~3~~ | ~~INJ-01~~ | ~~**HIGH**~~ | ~~PostgREST filter injection in MCP tools search~~ | ~~migration 0062, mcp-tools.ts~~ | ~~**FIXED** (search_public_credentials parameterized RPC)~~ |
| ~~4~~ | ~~RLS-01~~ | ~~**HIGH**~~ | ~~13 tables missing GRANT to authenticated role~~ | ~~migration 0062~~ | ~~**FIXED** (GRANT on all 13 tables)~~ |
| ~~5~~ | ~~RLS-02~~ | ~~**HIGH**~~ | ~~api_keys readable by non-admin org members~~ | ~~migration 0062~~ | ~~**FIXED** (ORG_ADMIN-only RLS policy)~~ |
| 6 | AUTH-01 | **HIGH** | `/jobs/process-anchors` unauthenticated, no rate limit | index.ts:338 | OPEN |
| 7 | SEC-01 | **HIGH** | Demo seed credentials in production Supabase | seed.sql | OPEN |
| ~~8~~ | ~~PII-03~~ | ~~**HIGH**~~ | ~~No data retention policy — tables grow unbounded~~ | ~~migration 0062~~ | ~~**FIXED** (cleanup_expired_data RPC + worker cron)~~ |

### Operational (from `docs/confluence/15_operational_runbook.md`)

| # | ID | Issue | Status |
|---|-----|-------|--------|
| 9 | OPS-01 | Apply migrations 0059-0063 to production Supabase | PENDING |
| 10 | OPS-02 | Strip demo seed accounts from production | PENDING |
| 11 | OPS-03 | Set Sentry DSN env vars (Vercel + Cloud Run) | PENDING |
| 12 | OPS-04 | Sentry source map upload plugin | PENDING |
| 13 | OPS-05 | AWS KMS key provisioning (mainnet signing) | PENDING |
| 14 | OPS-06 | Mainnet treasury funding | PENDING |
| 15 | OPS-07 | Key rotation (Stripe + Supabase service role) | PENDING |

---

## TIER 2: HIGH-PRIORITY UAT BUGS (user-facing, should fix before demo)

| # | ID | Severity | Bug | Component | Source |
|---|-----|----------|-----|-----------|--------|
| 16 | UAT2-01 | HIGH | Revoke action not wired in org table | OrganizationPage.tsx | uat_launch_readiness_2.md |
| 17 | UAT2-02 | HIGH | Template metadata fields not rendering in issuance form | IssueCredentialForm.tsx | uat_launch_readiness_2.md |
| 18 | UAT2-03 | HIGH | Settings page missing sub-page navigation | SettingsPage.tsx | uat_launch_readiness_2.md |
| 19 | UAT2-04 | HIGH | Bulk upload not accessible from any page | OrganizationPage.tsx | uat_launch_readiness_2.md |
| 20 | UAT2-05 | HIGH | Org record rows not clickable to detail | OrgRegistryTable.tsx | uat_launch_readiness_2.md |
| 21 | UAT3-01 | HIGH | DM Sans + JetBrains Mono fonts NOT loaded in app | index.html | uat_launch_readiness_3.md |

---

## TIER 3: MEDIUM UAT BUGS (polish, fix when possible)

| # | ID | Severity | Bug | Source |
|---|-----|----------|-----|--------|
| 22 | UAT-10 | MEDIUM | Secure Document button overlaps subtitle | uat_2026_03_15.md |
| 23 | UAT-11 | MEDIUM | Stat cards stacked vertically on desktop | uat_2026_03_15.md |
| 24 | UAT-12 | MEDIUM | Tablet viewport clips content | uat_2026_03_15.md |
| 25 | UAT-13 | MEDIUM | Account Type dual labels confusing | uat_2026_03_15.md |
| 26 | UAT-14 | MEDIUM | Seed data visible in prod-like env | uat_2026_03_15.md |
| 27 | UAT3-02 | MEDIUM | PENDING anchor shows "Verification Failed" | uat_launch_readiness_3.md |
| 28-35 | UAT2-06–13 | MEDIUM | 8 additional org admin flow bugs | uat_launch_readiness_2.md |

---

## TIER 4: LOW PRIORITY BUGS

| # | ID | Severity | Bug | Source |
|---|-----|----------|-----|--------|
| 36 | UAT-15 | LOW | No "Forgot Password" link | uat_2026_03_15.md |
| 37 | UAT-16 | LOW | No loading states during data fetch | uat_2026_03_15.md |
| 38 | UAT-17 | LOW | QR code URL shows localhost | uat_2026_03_15.md |
| 39 | UAT-LR1-02 | LOW | Misleading toast after sign-out | uat_launch_readiness_1.md |
| 40-43 | UAT2-14, UAT3-03–05 | LOW | 4 additional low bugs | uat_launch_readiness_2/3.md |

---

## TIER 5: NOT STARTED STORIES (post-launch backlog)

### P7 Go-Live — 2 not started
| ID | Description | Notes |
|----|-------------|-------|
| P7-TS-04 | (No individual scope) | Placeholder |
| P7-TS-06 | (No individual scope) | Placeholder |

### MVP Launch Gaps — 2 not started
| ID | Description | Priority |
|----|-------------|----------|
| MVP-12 | Dark mode toggle | LOW |
| MVP-20 | LinkedIn badge integration | LOW |

### P8 AI Intelligence — 4 not started (Phase II)
| ID | Description | Priority |
|----|-------------|----------|
| P8-S6 | Extraction learning / feedback loop | MEDIUM |
| P8-S8 | Duplicate detection (cross-org) | HIGH |
| P8-S9 | Admin review queue | HIGH |
| P8-S16 | Multi-language OCR support | LOW |

### GEO & SEO — 5 not started
| ID | Description | Priority |
|----|-------------|----------|
| GEO-03 | Publish /privacy and /terms on marketing site | CRITICAL |
| GEO-08 | Content expansion — 5 core pages | HIGH |
| GEO-09 | Community & brand presence launch | MEDIUM |
| GEO-10 | IndexNow for Bing/Copilot | MEDIUM |
| GEO-11 | YouTube explainers + VideoObject schema | MEDIUM |

### GEO & SEO — 3 partial
| ID | Description | Remaining |
|----|-------------|-----------|
| GEO-02 | LinkedIn entity + sameAs | Wikidata entry (external) |
| GEO-05 | Enhanced schema | speakable + AggregateOffer |
| GEO-12 | Security headers | CSP header (complex with Google Fonts) |

### INFRA — 1 partial
| ID | Description | Remaining |
|----|-------------|-----------|
| INFRA-07 | Sentry integration | Source map upload + DSN env vars in production |

---

## TIER 6: CODE TODOs

| File | Line | Comment |
|------|------|---------|
| Sidebar.tsx | 58 | `// TODO: migrate to profiles.is_platform_admin flag` |

---

## Social Accounts (Reference)

| Platform | URL |
|----------|-----|
| LinkedIn | https://www.linkedin.com/company/arkovatech |
| X/Twitter | https://x.com/arkovatech |
| YouTube | https://www.youtube.com/channel/UCTTDFFSLxl85omCeJ9DBvrg |
| GitHub | https://github.com/carson-see/ArkovaCarson |
| Email | hello@arkova.ai |

---

_This document is the single source of truth for all open work. Re-prioritized each session._
