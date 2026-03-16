# Arkova Unified Backlog — Single Source of Truth
_Last updated: 2026-03-16 | Re-prioritized each session per CLAUDE.md rules_

> **Rule:** All backlog items — stories, bugs, security findings, operational tasks, GEO items — exist in this single document. Prioritized and re-prioritized each session.

---

## Summary

| Category | Total | Done | Open | Blocking Launch? |
|----------|-------|------|------|:----------------:|
| Stories (NOT STARTED) | 13 | — | 13 | No (post-launch) |
| Stories (PARTIAL) | 4 | — | 4 | 1 blocking (INFRA-07) |
| Security Findings | 12 | 12 fixed | 0 | No |
| UAT Bugs | 38 | 33 | 5 | No (all MEDIUM/LOW) |
| Operational Tasks | 7 | 0 | 7 | **YES** |
| Code TODOs | 1 | — | 1 | No |
| **Total Open Items** | | | **30** | |

---

## TIER 1: LAUNCH BLOCKERS — ~~ALL SECURITY FINDINGS RESOLVED~~

### Security (from CISO audit — `docs/security/launch_readiness_security_audit.md`)

| # | ID | Severity | Issue | Status |
|---|-----|----------|-------|--------|
| ~~1~~ | ~~PII-01~~ | ~~**CRITICAL**~~ | ~~`actor_email` plaintext in audit_events~~ | ~~**FIXED** (migration 0061 — null_audit_pii_fields trigger + backfill)~~ |
| ~~2~~ | ~~PII-02~~ | ~~**CRITICAL**~~ | ~~No right-to-erasure / account deletion~~ | ~~**FIXED** (migration 0061+0065, account-delete.ts, DeleteAccountDialog.tsx)~~ |
| ~~3~~ | ~~INJ-01~~ | ~~**HIGH**~~ | ~~PostgREST filter injection in MCP tools~~ | ~~**FIXED** (migration 0062 — search_public_credentials parameterized RPC)~~ |
| ~~4~~ | ~~RLS-01~~ | ~~**HIGH**~~ | ~~13 tables missing GRANT to authenticated~~ | ~~**FIXED** (migration 0062 — GRANT on all 13 tables)~~ |
| ~~5~~ | ~~RLS-02~~ | ~~**HIGH**~~ | ~~api_keys readable by non-admin org members~~ | ~~**FIXED** (migration 0062 — ORG_ADMIN-only RLS policy)~~ |
| ~~6~~ | ~~AUTH-01~~ | ~~**HIGH**~~ | ~~`/jobs/process-anchors` unauthenticated~~ | ~~**FIXED** — verifyCronAuth (OIDC + CRON_SECRET), cronJobsLimiter rate limiting, audience check~~ |
| ~~7~~ | ~~SEC-01~~ | ~~**HIGH**~~ | ~~Demo seed credentials in production Supabase~~ | ~~**FIXED** — `scripts/strip-demo-seeds.sql` created. OPS-02 tracks execution on prod.~~ |
| ~~8~~ | ~~PII-03~~ | ~~**HIGH**~~ | ~~No data retention policy~~ | ~~**FIXED** (migration 0062 — cleanup_expired_data RPC + worker cron)~~ |

### Operational (from `docs/confluence/15_operational_runbook.md`)

| # | ID | Issue | Status |
|---|-----|-------|--------|
| 9 | OPS-01 | Apply migrations 0059-0065 to production Supabase | PENDING |
| 10 | OPS-02 | Run `scripts/strip-demo-seeds.sql` on production | PENDING |
| 11 | OPS-03 | Set Sentry DSN env vars (Vercel + Cloud Run) | PENDING |
| 12 | OPS-04 | Sentry source map upload plugin | PENDING |
| 13 | OPS-05 | AWS KMS key provisioning (mainnet signing) | PENDING |
| 14 | OPS-06 | Mainnet treasury funding | PENDING |
| 15 | OPS-07 | Key rotation (Stripe + Supabase service role) | PENDING |

---

## TIER 2: ~~HIGH-PRIORITY UAT BUGS~~ — ALL RESOLVED

| # | ID | Severity | Bug | Status |
|---|-----|----------|-----|--------|
| ~~16~~ | ~~UAT2-01~~ | ~~HIGH~~ | ~~Revoke action not wired in org table~~ | ~~**FIXED** — `onRevokeAnchor` prop wired in OrganizationPage + OrgRegistryTable dropdown~~ |
| ~~17~~ | ~~UAT2-02~~ | ~~HIGH~~ | ~~Template metadata fields not rendering~~ | ~~**FIXED** — `useCredentialTemplate` + `MetadataFieldRenderer` integrated in IssueCredentialForm (UF-05)~~ |
| ~~18~~ | ~~UAT2-03~~ | ~~HIGH~~ | ~~Settings page missing sub-page navigation~~ | ~~**FIXED** — Organization Settings card with links to Templates/Webhooks/API Keys (ORG_ADMIN-only)~~ |
| ~~19~~ | ~~UAT2-04~~ | ~~HIGH~~ | ~~Bulk upload not accessible from any page~~ | ~~**FIXED** — "Bulk Upload" button in Organization Records header~~ |
| ~~20~~ | ~~UAT2-05~~ | ~~HIGH~~ | ~~Org record rows not clickable to detail~~ | ~~**FIXED** — `onClick={() => onViewAnchor?.(anchor)}` on both mobile cards and desktop table rows~~ |
| ~~21~~ | ~~UAT3-01~~ | ~~HIGH~~ | ~~DM Sans + JetBrains Mono fonts NOT loaded~~ | ~~**FIXED** — Google Fonts link in index.html, font-family in CSS + Tailwind config verified~~ |

---

## TIER 3: MEDIUM UAT BUGS — MOSTLY RESOLVED

| # | ID | Severity | Bug | Status |
|---|-----|----------|-----|--------|
| ~~22~~ | ~~UAT-10~~ | ~~MEDIUM~~ | ~~Secure Document button overlaps subtitle~~ | ~~**FIXED** (PR #48)~~ |
| ~~23~~ | ~~UAT-11~~ | ~~MEDIUM~~ | ~~Stat cards stacked vertically on desktop~~ | ~~**FIXED** (PR #48)~~ |
| ~~24~~ | ~~UAT-12~~ | ~~MEDIUM~~ | ~~Tablet viewport clips content~~ | ~~**FIXED** (PR #48)~~ |
| ~~25~~ | ~~UAT-13~~ | ~~MEDIUM~~ | ~~Account Type dual labels confusing~~ | ~~**FIXED** (PR #48)~~ |
| ~~26~~ | ~~UAT-14~~ | ~~MEDIUM~~ | ~~Seed data visible in prod-like env~~ | ~~**FIXED** (PR #48 + SEC-01 strip script)~~ |
| ~~27~~ | ~~UAT3-02~~ | ~~MEDIUM~~ | ~~PENDING anchor shows "Verification Failed"~~ | ~~**FIXED** — Code handles PENDING (PublicVerification.tsx). Migration 0054 adds PENDING to get_public_anchor. Apply OPS-01 to production.~~ |
| ~~28~~ | ~~UAT2-06~~ | ~~MEDIUM~~ | ~~No "Invite Member" button~~ | ~~**FIXED** — Invite Member button + InviteMemberModal wired in OrganizationPage~~ |
| ~~29~~ | ~~UAT2-07~~ | ~~MEDIUM~~ | ~~No "Change Role" action in member dropdown~~ | ~~**FIXED** — onChangeRole prop wired in MembersTable with toggle Admin/Member~~ |
| ~~30~~ | ~~UAT2-10~~ | ~~MEDIUM~~ | ~~Mobile records table shows only Document column~~ | ~~**FIXED** — Mobile card layout (`sm:hidden`) with status badges + actions~~ |
| 31 | UAT2-08 | MEDIUM | Member names not clickable — no member detail view | OPEN (enhancement) |
| 32 | UAT2-09 | MEDIUM | Credential Templates page shows empty state | OPEN (seed data — production templates needed) |
| 33 | UAT2-15 | MEDIUM | Mobile sidebar missing bottom nav items | OPEN |

---

## TIER 4: LOW PRIORITY BUGS

| # | ID | Severity | Bug | Status |
|---|-----|----------|-----|--------|
| ~~34~~ | ~~UAT-15~~ | ~~LOW~~ | ~~No "Forgot Password" link~~ | ~~**FIXED** (PR #48)~~ |
| ~~35~~ | ~~UAT-16~~ | ~~LOW~~ | ~~No loading states during data fetch~~ | ~~**FIXED** (PR #48)~~ |
| ~~36~~ | ~~UAT-17~~ | ~~LOW~~ | ~~QR code URL shows localhost~~ | ~~**FIXED** (PR #48)~~ |
| 37 | UAT-LR1-02 | LOW | Misleading toast after sign-out | OPEN |
| 38 | UAT2-11 | LOW | Expired/Revoked badges visually identical | OPEN (cosmetic) |
| 39 | UAT2-12 | LOW | Template creation uses raw JSON instead of visual builder | OPEN |
| 40 | UAT2-13 | LOW | No "Recipient" column in org records table | OPEN — column exists (`hidden md:table-cell`) but may not show recipient |
| 41 | UAT2-14 | LOW | "Failed to fetch" error on API Keys page | OPEN (requires worker running) |
| 42 | UAT3-03 | LOW | No loading skeleton on verification page | OPEN (cosmetic) |
| 43 | UAT3-04 | LOW | QR code on detail page links to localhost | OPEN (same as UAT-17 for authenticated views) |
| 44 | UAT3-05 | LOW | Missing toast on billing page auth redirect | OPEN |

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
