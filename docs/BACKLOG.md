# Arkova Unified Backlog — Single Source of Truth
_Last updated: 2026-03-21 (OPS-08 WIF fixed + deployed rev 00024, AuthCallbackPage OAuth race fix, TLA-01/02 fixed, error serialization improved) | Re-prioritized each session per CLAUDE.md rules_

> **Rule:** All backlog items — stories, bugs, security findings, operational tasks, GEO items — exist in this single document. Prioritized and re-prioritized each session.

---

## Summary

| Category | Total | Done | Open | Blocking Beta? |
|----------|-------|------|------|:--------------:|
| **BETA Readiness Stories** | **13** | **13** | **0** | No (all complete) |
| BETA Activation Items | 2 | 2 | 0 | No (signet confirmed) |
| E2E Validation Bugs | 7 | 7 fixed | 0 | No |
| Demo Readiness (DEMO) | 4 | 2 | 2 | No (enhancement) |
| Stories (NOT STARTED) | 8 | — | 8 | No (post-launch) |
| Stories (PARTIAL) | 2 | — | 2 | 1 blocking (INFRA-07) |
| Security Findings | 12 | 12 fixed | 0 | No |
| UAT Bugs | 29 | 29 | 0 | No |
| Audit Findings | 24 | 24 resolved | 0 | No |
| Operational Tasks | 7 | 0 | 7 | **YES** |
| TLA+ Verification Findings | 3 | 3 fixed | 0 | No |
| Code TODOs | 1 | — | 1 | No |
| **Total Open Items** | | | **19** | |

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
| 9 | ~~OPS-01~~ | ~~Apply migrations 0059-0073 to production Supabase + regenerate types~~ | **DONE** — All migrations applied (0059-0073) |
| 10 | OPS-02 | Run `scripts/strip-demo-seeds.sql` on production | PENDING |
| 11 | OPS-03 | Set Sentry DSN env vars (Vercel + Cloud Run) | PENDING |
| 12 | OPS-04 | Sentry source map upload plugin | PENDING |
| 13 | OPS-05 | AWS KMS key provisioning (mainnet signing) | PENDING |
| 14 | OPS-06 | Mainnet treasury funding | PENDING |
| 15 | OPS-07 | Key rotation (Stripe + Supabase service role) | PENDING |
| 16 | ~~OPS-08~~ | ~~Fix BITCOIN_TREASURY_WIF in Secret Manager~~ | **FIXED** — Secret Manager v3, rev `arkova-worker-00024-f9p`, treasury `tb1ql90xtpfzpyc03d2dghggqfdksfxe6ucjufah0r` confirmed. TX `a5f6d9d9...` broadcast. |

---

## TIER 1B: BETA READINESS — 13/13 COMPLETE

_Discovered 2026-03-17 via end-to-end workflow audit. Full story docs: [16_beta_readiness.md](stories/16_beta_readiness.md)_
_All 13 stories completed 2026-03-18 (PRs #98, #100, #101). Migrations 0068-0071._

### Sprint 1 — Core Demo Path (P0/P1)

| # | ID | Priority | Story | Workflows | Effort | Status |
|---|-----|----------|-------|-----------|--------|--------|
| 1 | BETA-01 | **P0** | Mempool live transaction tracking (worker cron + realtime UI) | WF1, WF4 | Medium | **COMPLETE** |
| 2 | BETA-02 | **P0** | Revocation Bitcoin transaction (OP_RETURN on revoke) | WF1 | Medium | **COMPLETE** |
| 3 | BETA-03 | **P0** | Email infrastructure (Resend + templates) | WF1, WF3 | Medium | **COMPLETE** |
| 4 | BETA-04 | **P1** | Auto-create user on admin upload + activation email | WF1 | Medium | **COMPLETE** |
| 5 | BETA-05 | **P1** | XLSX batch upload support (SheetJS) | WF2 | Small | **COMPLETE** |

### Sprint 2 — Individual User + Batch AI (P1/P2)

| # | ID | Priority | Story | Workflows | Effort | Status |
|---|-----|----------|-------|-----------|--------|--------|
| 6 | BETA-06 | **P1** | Per-row AI extraction for batch uploads | WF2 | Medium | **COMPLETE** |
| 7 | BETA-07 | **P1** | Two-factor authentication (Supabase MFA/TOTP) | WF3 | Medium | **COMPLETE** |
| 8 | BETA-08 | **P2** | Template selection before anchoring (individual users) | WF3 | Small | **COMPLETE** |
| 9 | BETA-09 | **P2** | LinkedIn verification badge + share link | WF3 | Small | **COMPLETE** |
| 10 | BETA-10 | **P2** | Public search by person (not just fingerprint) | WF4 | Small | **COMPLETE** |

### Sprint 3 — Public Display Polish (P2/P3)

| # | ID | Priority | Story | Workflows | Effort | Status |
|---|-----|----------|-------|-----------|--------|--------|
| 11 | BETA-11 | **P2** | Mempool explorer link in verification results | WF4 | Tiny | **COMPLETE** |
| 12 | BETA-12 | **P2** | Immutable description field on anchors | WF4 | Small | **COMPLETE** |
| 13 | BETA-13 | **P3** | Realtime anchor status subscriptions (Supabase channels) | WF1, WF3 | Small | **COMPLETE** |

### Activation Items (config only, no new code)

| # | ID | What | Fix |
|---|-----|------|-----|
| — | BETA-ACT-01 | AI extraction disabled by default | Set `ENABLE_AI_EXTRACTION=true` + configure `GEMINI_API_KEY` |
| — | ~~BETA-ACT-02~~ | ~~Bitcoin anchoring uses mocks~~ | ~~**DONE** — `ENABLE_PROD_NETWORK_ANCHORING=true` + signet treasury funded. 6+ real Signet txs confirmed end-to-end.~~ |

### Workflows Fully Implemented (no gaps found)

- **WF5:** Fraud detection — AI integrity scoring + admin review queue + specific flag reasons
- **WF6:** Verification API — 13+ endpoints, API key mgmt, rate limiting, billing wired
- **WF7:** Payments — Stripe checkout, 4 webhook handlers, credit system, 3 price tiers
- **WF8:** Navigation — Header + Sidebar + Breadcrumbs, profile accessible from all screens

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
| ~~31~~ | ~~UAT2-08~~ | ~~MEDIUM~~ | ~~Member names not clickable — no member detail view~~ | ~~**FIXED** — MemberDetailPage exists and is routed at `/organization/member/:memberId`~~ |
| ~~32~~ | ~~UAT2-09~~ | ~~MEDIUM~~ | ~~Credential Templates page shows empty state~~ | ~~**FIXED** — Starter template suggestions (Diploma, Certificate, License) shown in empty state~~ |
| ~~33~~ | ~~UAT2-15~~ | ~~MEDIUM~~ | ~~Mobile sidebar missing bottom nav items~~ | ~~**FIXED** — Added `overflow-y-auto` to mobile sidebar panel~~ |

---

## TIER 4: LOW PRIORITY BUGS

| # | ID | Severity | Bug | Status |
|---|-----|----------|-----|--------|
| ~~34~~ | ~~UAT-15~~ | ~~LOW~~ | ~~No "Forgot Password" link~~ | ~~**FIXED** (PR #48)~~ |
| ~~35~~ | ~~UAT-16~~ | ~~LOW~~ | ~~No loading states during data fetch~~ | ~~**FIXED** (PR #48)~~ |
| ~~36~~ | ~~UAT-17~~ | ~~LOW~~ | ~~QR code URL shows localhost~~ | ~~**FIXED** (PR #48)~~ |
| ~~37~~ | ~~UAT-LR1-02~~ | ~~LOW~~ | ~~Misleading toast after sign-out~~ | ~~**FIXED** — sessionStorage flag set BEFORE signOut call, explicit user/session clearing~~ |
| ~~38~~ | ~~UAT2-11~~ | ~~LOW~~ | ~~Expired/Revoked badges visually identical~~ | ~~**FIXED** — REVOKED=destructive (red), EXPIRED=outline (amber) across AssetDetailView + RecordsList~~ |
| ~~39~~ | ~~UAT2-12~~ | ~~LOW~~ | ~~Template creation uses raw JSON instead of visual builder~~ | ~~**FIXED** — TemplateSchemaBuilder visual builder already exists with 6 field types~~ |
| ~~40~~ | ~~UAT2-13~~ | ~~LOW~~ | ~~No "Recipient" column in org records table~~ | ~~**FIXED** — Recipient display added to mobile card layout~~ |
| ~~41~~ | ~~UAT2-14~~ | ~~LOW~~ | ~~"Failed to fetch" error on API Keys page~~ | ~~**FIXED** — fetchError prop added to ApiKeySettings, graceful error display when worker unavailable~~ |
| ~~42~~ | ~~UAT3-03~~ | ~~LOW~~ | ~~No loading skeleton on verification page~~ | ~~**FIXED** — Shimmer skeleton already exists in PublicVerification loading state~~ |
| ~~43~~ | ~~UAT3-04~~ | ~~LOW~~ | ~~QR code on detail page links to localhost~~ | ~~**FIXED** — All copy/QR URLs use `verifyUrl()` (production base URL)~~ |
| ~~44~~ | ~~UAT3-05~~ | ~~LOW~~ | ~~Missing toast on billing page auth redirect~~ | ~~**FIXED** — AuthGuard already shows redirect toast for all auth redirects including billing~~ |

---

## TIER 4B: CODEBASE AUDIT FINDINGS (2026-03-17)

128 findings across 24 AUDIT stories from comprehensive codebase audit. Tracked across PRs #88-91.

| # | ID | Category | Issue | Status | PR |
|---|-----|----------|-------|--------|-----|
| 1 | AUDIT-01 | SQL Bugs | 6 migration bugs (CHECK constraint, operator precedence, column names) | ✅ FIXED | #88 |
| 2 | AUDIT-02 | Code Bugs | 4 runtime bugs (infinite re-render, shutdown race, metadata overwrite) | ✅ FIXED | #88 |
| 3 | AUDIT-03 | Security | Edge worker auth (cron secret, constant-time compare) | ✅ FIXED | #88 |
| 4 | AUDIT-04 | Security | SSRF blocklist, prompt injection, MCP CORS | ✅ FIXED | #88 |
| 5 | AUDIT-05 | Config | Missing env vars, dead code in config, hardcoded defaults | ✅ FIXED | #89 |
| 6 | AUDIT-06 | CI Gaps | Edge worker tsc not in CI, no npm audit step | ✅ FIXED | #90 |
| 7 | AUDIT-07 | Resilience | No sub-route error boundaries (one crash takes down app) | ✅ FIXED | #91 |
| 8 | AUDIT-08 | Worker | Inconsistent error handling in worker jobs | ✅ FIXED | #89 |
| 9 | AUDIT-09 | Accessibility | Skip-to-content link missing, form label gaps | ✅ FIXED (skip link) | #91 |
| 10 | AUDIT-10 | Edge | Error handling gaps in edge workers (DLQ, MCP, AI fallback) | ✅ FIXED | #90 |
| 11 | AUDIT-11 | Config | Unused dependencies, mismatched versions | ✅ FIXED | #89 |
| 12 | AUDIT-12 | Testing | Missing test coverage for critical paths | ✅ FIXED | #92 |
| 13 | AUDIT-13 | Performance | No route-level code splitting (large initial bundle) | ✅ FIXED | #91 |
| 14 | AUDIT-14 | API Docs | AI endpoints missing from OpenAPI spec | ✅ FIXED | #91 |
| 15 | AUDIT-15 | Dead Code | Duplicate backup files (" 2" suffix) | ✅ FIXED | #91 |
| 16 | AUDIT-16 | Compliance | SOC 2 docs missing (incident response, data classification) | ✅ FIXED | #91 |
| 17 | AUDIT-17 | Schema | Missing DB indexes on frequently queried columns | ✅ FIXED | #92 |
| 18 | AUDIT-18 | Monitoring | No structured health check endpoint aggregation | ✅ FIXED | #92 |
| 19 | AUDIT-19 | API | Rate limit headers inconsistent across endpoints | ✅ RESOLVED (false positive — headers already consistent) | — |
| 20 | AUDIT-20 | Testing | RLS tests missing for newer tables | ✅ FIXED | #90 |
| 21 | AUDIT-21 | Types | `as any` casts for Supabase RPCs (systemic — 19 occurrences) | ✅ FIXED (worker: callRpc wrapper; frontend: deferred to OPS-01 type regen) | #92 |
| 22 | AUDIT-22 | Logging | Inconsistent log levels across worker modules | ✅ RESOLVED (intentional — circular dependency prevents logger in bootstrap) | #92 |
| 23 | AUDIT-23 | Edge | Edge worker type bindings incomplete | ✅ RESOLVED (false positive — bindings already typed in env.ts) | — |
| 24 | AUDIT-24 | Docs | Architecture docs outdated for P8 AI features | ✅ FIXED | #92 |

**Summary:** 24/24 RESOLVED across PRs #88-92. All audit findings addressed.

---

## TIER 5: NOT STARTED STORIES (post-launch backlog)

### P7 Go-Live — 2 not started
| ID | Description | Notes |
|----|-------------|-------|
| P7-TS-04 | (No individual scope) | Placeholder |
| P7-TS-06 | (No individual scope) | Placeholder |

### MVP Launch Gaps — 1 not started
| ID | Description | Priority |
|----|-------------|----------|
| MVP-12 | Dark mode toggle | LOW |

> ~~MVP-20 (LinkedIn badge integration)~~ — Superseded by BETA-09 (LinkedInShare.tsx)

### ~~P8 AI Intelligence — ALL COMPLETE (19/19)~~
_All P8 stories complete including Phase II: P8-S6 (feedback loop), P8-S8 (integrity scoring), P8-S9 (review queue), P8-S16 (AI reports). Completed via PR #80._

### GEO & SEO — 5 not started
| ID | Description | Priority |
|----|-------------|----------|
| GEO-03 | Publish /privacy and /terms on marketing site | CRITICAL |
| GEO-08 | Content expansion — 5 core pages | HIGH |
| GEO-09 | Community & brand presence launch | MEDIUM |
| GEO-10 | IndexNow for Bing/Copilot | MEDIUM |
| GEO-11 | YouTube explainers + VideoObject schema | MEDIUM |

### GEO & SEO — 2 partial
| ID | Description | Remaining |
|----|-------------|-----------|
| GEO-02 | LinkedIn entity + sameAs | Wikidata entry (external) |
| ~~GEO-05~~ | ~~Enhanced schema~~ | ~~**COMPLETE** — speakable + AggregateOffer deployed~~ |
| ~~GEO-12~~ | ~~Security headers~~ | ~~**COMPLETE** — vercel.json headers deployed~~ |

### INFRA — 1 partial
| ID | Description | Remaining |
|----|-------------|-----------|
| INFRA-07 | Sentry integration | Source map upload + DSN env vars in production |

---

## TIER 5B: FORMAL VERIFICATION FINDINGS (2026-03-17)

_From TLA+ model checking of Bitcoin anchor state machine (`machines/bitcoinAnchor.machine.ts`)._

| # | ID | Category | Finding | Status | Action |
|---|-----|----------|---------|--------|--------|
| 1 | ~~TLA-01~~ | ~~Schema Gap~~ | ~~`credential_type` column is NOT immutable after SECURED~~ | **FIXED** | Migration 0073 + TLA+ model INV-7 |
| 2 | ~~TLA-02~~ | ~~CI Gate~~ | ~~TLA+ verification not in CI pipeline~~ | **FIXED** | Added `tla-verify` job to `.github/workflows/ci.yml` |
| 3 | TLA-03 | Design Fix | Legal hold invariant was overly strict — disallowed valid legal hold on revoked anchors | **FIXED** | Invariant refined in model (PR #94) |

### ~~TLA-01: credential_type Immutability~~ — FIXED

Migration `0073_credential_type_immutability.sql` adds `credential_type` guard to `protect_anchor_status_transition()` trigger. Blocks changes when status is SUBMITTED, SECURED, or REVOKED. TLA+ model updated with `credentialTypeLocked` variable and INV-7 invariant. Applied to production Supabase.

### ~~TLA-02: CI Gate for State Machine Verification~~ — FIXED

Added `tla-verify` job to CI pipeline (`.github/workflows/ci.yml`). Runs `npx tla-precheck check machines/bitcoinAnchor.machine.ts` on PRs that modify `machines/`, `services/worker/src/jobs/anchor.ts`, or `services/worker/src/chain/`. Skips automatically if no relevant files changed.

---

## TIER 5C: DEMO READINESS (2026-03-20)

_Discovered during E2E demo readiness session. Enhancement items for demo polish and verification UX._

| # | ID | Priority | Description | Status |
|---|-----|----------|-------------|--------|
| 1 | DEMO-01 | **HIGH** | OP_RETURN metadata hash — include truncated SHA-256 of metadata JSON alongside document fingerprint in OP_RETURN. Format: `ARKV` + 32 bytes doc fingerprint + 8 bytes metadata hash. Enables fully independent verification of both document and metadata without Arkova. | **COMPLETE** |
| 2 | DEMO-02 | **HIGH** | Verification walkthrough UI — "How Verification Works" explainer on record detail page. Explains: (1) SHA-256 fingerprint = the document's unique identity, (2) OP_RETURN on network = permanent timestamped proof, (3) anyone can verify by hashing the document and searching the network, (4) no dependency on Arkova being online. | **COMPLETE** |
| 3 | ~~DEMO-03~~ | ~~**MEDIUM**~~ | ~~Search page dark mode~~ | **RESOLVED** — `useTheme()` already called at App root (line 106 of App.tsx). Public routes inherit dark class via `document.documentElement`. No code change needed. |
| 4 | DEMO-04 | **LOW** | Credential template visual rendering — upgrade CredentialRenderer to show diploma-style visual cards for different credential types (degree, license, certificate). | NOT STARTED |

---

## TIER 5D: E2E VALIDATION BUGS (2026-03-20)

_From E2E journey validation across 7 user flows. Report: `docs/bugs/e2e_journey_validation.md`._

| # | ID | Severity | Bug | Status |
|---|-----|----------|-----|--------|
| 1 | BUG-E2E-01 | **CRITICAL** | UTXO provider defaults to testnet4 URL when network is signet | **FIXED** — Network-aware `MEMPOOL_URLS` map in `utxo-provider.ts` |
| 2 | BUG-E2E-02 | MEDIUM | ExplorerLink fallback defaults to testnet4 | **FIXED** — Changed to signet |
| 3 | BUG-E2E-03 | MEDIUM | TreasuryAdminPage banned term + wrong env var | **FIXED** — Simplified to `{network?.name ?? 'signet'}` |
| 4 | BUG-E2E-04 | **HIGH** | recipients.ts uses invalid role 'MEMBER' | **FIXED** — Changed to 'ORG_MEMBER' |
| 5 | BUG-E2E-05 | MEDIUM | switchboard_flags 'value' column not in generated types | **FIXED** — Type assertion workaround (full fix: OPS-01 type regen) |
| 6 | BUG-E2E-06 | LOW | Email sender test type error | **FIXED** — Explicit type annotation |
| 7 | BUG-E2E-07 | LOW | Missing supertest dev dependency | **FIXED** — Installed as dev dep |

**Summary:** 7/7 FIXED. Test counts after all sessions: 929 frontend + 1,010 worker = 1,939 total. Typecheck clean. Copy lint clean.

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
