# Arkova Unified Backlog — Single Source of Truth
_Last updated: 2026-04-17 (evening — 1.41M+ public records, 1.41M+ SECURED anchors on mainnet, 4,325 tests, 209 migrations (0000-0218, prod through 0185, 19 pending), **Nessie v27.3 FCRA UNDER_REVIEW / v28.0 HIPAA + v29.0 FERPA QUARANTINED (NVI-15)**, Gemini Golden **v6 trained + eval'd** cutover pending, **v7 failed DoD**, intelligence dataset **343 scenarios + 209 anchored sources** + **NVI validators shipped 2026-04-17 (NVI-01..04 + NVI-15 + NVI-18 CI guard)**, Phase 1.5 15/16, NMT 14/14, ATS 8/8, NCE 20/20 built, **NCA 9/10 shipped 2026-04-17 (NCA-01..09 across #411/#413/#414)**, **INTL 3/6 shipped (INTL-04/05/06 in #413)**, **TRUST 1/7 shipped (TRUST-07 CE+ readiness in #413)**, **INT 8/9**, DEP 4/23, **NVI 6/18 shipped**; NVI-05..14/16/17 remain, **NDD/NSS/NTF paused per NVI decree**, **CONT epic SCRUM-874** + **FEDCONT epic SCRUM-875** | Follow-ups: SCRUM-888 (SIC), -889 (Thailand), -890 (Malaysia), -891 (IASME), -892 (NPH-16 deploy), -893 (NCA engineering bundle)) | Re-prioritized each session per CLAUDE.md rules_

> **Rule:** All backlog items — stories, bugs, security findings, operational tasks, GEO items — exist in this single document. Prioritized and re-prioritized each session.

---

## 2026-04-17 (evening) sprint — 10 stories shipped across PR #413 + PR #414

**Shipped (all QA-merged, awaiting production deploy + external operator steps):**

| Story | Ticket | PR | Notes |
|-------|--------|----|-------|
| NCA-05 Recommendation Engine | SCRUM-760 | #413 | Pure `buildRecommendations`, 20-item cap, `gap_keys` drill-down; persisted in `compliance_audits.metadata.recommendations` |
| NCA-06 Regulatory Change Impact | SCRUM-761 | #414 | Pure impact calculator + cron orchestrator (not yet wired to Cloud Scheduler — see SCRUM-893) |
| NCA-07 Audit Dashboard Button | SCRUM-762 | #414 | ARIA-live state machine; slotted above ComplianceScoreCard for ORG_ADMIN |
| NCA-08 Compliance Scorecard | SCRUM-763 | #414 | `/compliance/scorecard` — gauge + bars + gaps + grouped recs + SVG timeline |
| NCA-09 PDF Export | SCRUM-764 | #414 | jsPDF US-Letter, browser-only (Constitution 1.6) |
| INTL-04 Colombia Law 1581 | SCRUM-724 | #413 | Privacy notice + SIC RNBD packet |
| INTL-05 Thailand PDPA | SCRUM-725 | #413 | Privacy notice + ASEAN/GDPR-aligned SCC annex |
| INTL-06 Malaysia PDPA 2024 | SCRUM-726 | #413 | Privacy notice + Transfer Impact Assessment template |
| TRUST-07 UK Cyber Essentials Plus | SCRUM-720 | #413 | Readiness checklist covering all 5 CE+ control themes |
| NPH-16 Deploy API Keys | SCRUM-728 | #414 | Runbook + pre-deploy verification script (operator-executed) |

**Follow-up tickets created (6):**

| Ticket | Type | Blocks |
|--------|------|--------|
| SCRUM-888 | Operator — File Colombia SIC RNBD registration | SCRUM-724 |
| SCRUM-889 | Operator — Engage Thailand counsel (SCC + PDPA DPO) | SCRUM-725 |
| SCRUM-890 | Operator — Engage Malaysia counsel (TIA + PDP DPO) | SCRUM-726 |
| SCRUM-891 | Operator — Engage IASME CE+ assessor | SCRUM-720 |
| SCRUM-892 | Operator — `gcloud run services update` for OpenStates/SAM.gov/CourtListener keys | SCRUM-728 |
| SCRUM-893 | Engineering bundle — Cloud Scheduler wiring, gap filters, PDF SVG gauge, Nessie RAG text, integrity JOIN, UAT | Relates to SCRUM-760..764 |

**Migration:** 0218 `notifications` table (NCA-06 in-app notifications — RLS, CHECK constraint, unread index).

**Code-review findings fixed in-session (commit 920938bf on PR #414):**
1. `anchors.not_after` → `expires_at` + `title` → `label` (both `regulatory-change-cron.ts` + pre-existing `compliance-audit.ts` schema mismatch flagged on PR #411)
2. `persistChangeEvent` now writes full `currentAudit` state (prevents scorecard clobber + self-poisoning delta)
3. 5 hardcoded UI strings in `ComplianceScorecardPage.tsx` moved to `AUDIT_MY_ORG_LABELS.SCORECARD_*`
4. Migration 0218 replaces the runtime try/catch on `notifications` insert

---

## Summary

| Category | Total | Done | Open | Blocking Beta? |
|----------|-------|------|------|:--------------:|
| **BETA Readiness Stories** | **13** | **13** | **0** | No (all complete) |
| BETA Activation Items | 2 | 2 | 0 | No (signet confirmed) |
| E2E Validation Bugs | 7 | 7 fixed | 0 | No |
| Demo Readiness (DEMO) | 4 | 4 | 0 | No |
| Phase 1.5 Foundation | 16 | 15 | 1 | No |
| AI Infrastructure (Session 12) | 6 | 6 | 0 | No (all complete) |
| UX Overhaul (Sessions 9-10) | 7 | 7 | 0 | No (all complete) |
| P8 AI Intelligence | 19 | 19 | 0 | No (all complete) |
| Compliance Mapping Layer (CML) | 5 | 5 | 0 | No (all complete) |
| Verifiable AI (VAI) | 5 | 3 | 2 | No (Phase III) |
| ~~Nessie Model Training (NMT)~~ | ~~14~~ | ~~14~~ | ~~0~~ | ~~No (all complete)~~ |
| **Nessie Compliance Engine (NCE)** | **23** | **0** | **23** | **No (strategic; now gated on NVI)** |
| **Nessie Verification Infrastructure (NVI)** ★ NEW 2026-04-16 | **12** | **0** | **12** | **No — but gates NDD/NSS/NTF** |
| ~~Gemini Migration (GME-01–20)~~ | ~~26~~ | ~~—~~ | ~~—~~ | **SUPERSEDED by GME2** (2.0-flash is prod, no 2.5 deadline) |
| **Gemini Golden Evolution (GME2)** ★ ACTIVE | **5** | **0** | **5** | No (v6 cutover pending; v7 designed) |
| **Gemini Golden Domain Experts (GME3/4/5)** ★ NEW 2026-04-16 | **3** | **0** | **3** | No (gated on v7 + GME8 router) |
| **Nessie Domain Depth (NDD)** ★ PAUSED by NVI | **13** | **0** | **13** | No (paused) |
| **Nessie State Specialization (NSS)** ★ PAUSED by NVI | **8** | **0** | **8** | No (paused) |
| **Nessie Training Foundation (NTF)** ★ PAUSED beyond v6 | **8** | **1** | **7** | No (paused) |
| **Nessie Compliance Audit (NCA)** ★ ACTIVE | **10** | **0** | **10** | No (product-facing, not model-gated) |
| **API Richness (API-RICH)** ★ NEW 2026-04-16 | **5** | **0** | **5** | No (converts stored data → response) |
| **Contract Expertise (CONT)** ★ NEW 2026-04-16 epic SCRUM-874 | **4+** | **0** | **4** | No (NVI-gated; seeds SCRUM-791 + 3 new) |
| **Federal Contracting (FEDCONT)** ★ NEW 2026-04-16 epic SCRUM-875 | **3+** | **0** | **3** | No (NVI-gated except SAM.gov fetcher) |
| **Integration Surface (INT)** | **9** | **8** | **1** | No (webhook CRUD open) |
| Phase 2 Agentic Layer | 6 | 6 | 0 | No (all complete) |
| Phase 3 eSignature (SCRUM-421) | 3 | 0 | 3 | No (in progress) |
| Compliance & Audit Readiness (SCRUM-426) | 8 | 8 | 0 | No (all complete) |
| Dependency Hardening (DEP) | 10 | 1 | 9 | No |
| International Compliance (REG) | 28 | 0 | 28 | No |
| International Regulatory Expansion (INTL) ★ NEW | 6 | 0 | 6 | No (deferred — customer-gated) |
| Trust Framework (TRUST) ★ NEW | 7 | 0 | 7 | No (deferred — external vendor) |
| Stories (NOT STARTED) | 5 | — | 5 | No (post-launch) |
| ATS & Background Checks | 8 | 8 | 0 | No (all complete) |
| Stories (PARTIAL) | 2 | — | 2 | No (external/ops) |
| Security Findings | 12 | 12 fixed | 0 | No |
| UAT Bugs (legacy) | 29 | 29 | 0 | No |
| Production UAT Bugs (2026-04) | 19 | 19 | 0 | No (all resolved) |
| Production UAT Bugs (2026-04-05 Click-Through) | 10 | 0 | 10 | **YES (3 HIGH)** |
| Audit Findings | 24 | 24 resolved | 0 | No |
| GitHub CodeQL | 29 | 9 fixed | 20 | No (false positives) |
| Operational Tasks | 8 | 2 | 6 | **YES** |
| TLA+ Verification Findings | 3 | 3 fixed | 0 | No |
| Code TODOs | 1 | — | 1 | No |
| QA Audit (PR #162) | 25 | 25 resolved | 0 | No |
| **Total Open Items** | | | **~110** | |

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
| 9 | ~~OPS-01~~ | ~~Apply migrations 0059-0071 to production Supabase + regenerate types~~ | **DONE** — All migrations applied (0059-0075) |
| 10 | ~~OPS-02~~ | ~~Run `scripts/strip-demo-seeds.sql` on production~~ | **DONE** — Session 6: `admin@umich-demo.arkova.io` deleted, 0 demo users remain |
| 11 | OPS-03 | Set Sentry DSN env vars (Vercel + Cloud Run) | PENDING |
| 12 | OPS-04 | Sentry source map upload plugin | PENDING |
| 13 | ~~OPS-05~~ | ~~AWS KMS key provisioning (mainnet signing)~~ | **DONE** — GCP KMS configured, 116 mainnet TXs |
| 14 | ~~OPS-06~~ | ~~Mainnet treasury funding~~ | **DONE** — Treasury funded, 166K+ SECURED anchors |
| 15 | OPS-07 | Key rotation (Stripe + Supabase service role) | PENDING |
| 16 | ~~OPS-08~~ | ~~Fix BITCOIN_TREASURY_WIF in Secret Manager~~ | **FIXED** — Secret Manager version 3 set to correct WIF. Revision `arkova-worker-00024-f9p` deployed, treasury address confirmed `tb1ql90xtpfzpyc03d2dghggqfdksfxe6ucjufah0r`. PENDING anchor processed to SUBMITTED (TX `a5f6d9d9...`). |

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

## TIER 1C: PRODUCTION UAT BUGS (2026-04-03 Jira Sync)

_Discovered via Jira UAT sweep (SCRUM-347 epic). 19 bugs filed, 5 already resolved. Synced from Jira 2026-04-03._

### HIGHEST Priority (500 errors — production broken)

| # | Jira | Severity | Bug | Status |
|---|------|----------|-----|--------|
| ~~1~~ | ~~SCRUM-348~~ | ~~**HIGHEST**~~ | ~~Search RPC returns 500~~ | **DONE** (prod migrations 0157+0160/0161 fixed GRANTs) |
| ~~2~~ | ~~SCRUM-349~~ | ~~**HIGHEST**~~ | ~~Attestations API returns 500~~ | **DONE** (migration 0149 applied — RLS recursion fix) |
| ~~3~~ | ~~SCRUM-351~~ | ~~**HIGHEST**~~ | ~~lookup_org_by_email_domain RPC returns 400~~ | **DONE** (migration 0148 applied — deleted_at column fix) |
| ~~4~~ | ~~SCRUM-352~~ | ~~**HIGHEST**~~ | ~~Anchors API returns 500 — admin overview metrics~~ | **DONE** (admin-stats.ts: Promise.allSettled + fee query cap) |

### HIGH Priority

| # | Jira | Severity | Bug | Status |
|---|------|----------|-----|--------|
| ~~5~~ | ~~SCRUM-353~~ | ~~HIGH~~ | ~~Credits showing limits during beta~~ | **DONE** (BillingPage.tsx: force recordsLimit null) |
| ~~6~~ | ~~SCRUM-354~~ | ~~HIGH~~ | ~~CSP frame-ancestors in meta tag~~ | **DONE** (vite.config.ts: X-Frame-Options header for dev) |
| ~~7~~ | ~~SCRUM-355~~ | ~~HIGH~~ | ~~Developers page shows SIGN IN when logged in~~ | **DONE** (skeleton loader during auth loading) |
| ~~8~~ | ~~SCRUM-357~~ | ~~HIGH~~ | ~~Page header says "Dashboard" on all admin pages~~ | **DONE** (added ADMIN_SUBSCRIPTIONS to PAGE_TITLES) |
| ~~9~~ | ~~SCRUM-358~~ | ~~HIGH~~ | ~~Treasury page uses banned terminology "Bitcoin"~~ | **DONE** (JSDoc comments updated, UI was already clean) |
| ~~10~~ | ~~SCRUM-359~~ | ~~HIGH~~ | ~~Treasury page shows all zeros despite 1.39M records~~ | **DONE** (prod migration 0160 applied — RPC GRANTs) |

### MEDIUM Priority

| # | Jira | Severity | Bug | Status |
|---|------|----------|-----|--------|
| ~~11~~ | ~~SCRUM-360~~ | ~~MEDIUM~~ | ~~Organization sidebar link non-functional for Individual accounts~~ | **DONE** |
| ~~12~~ | ~~SCRUM-361~~ | ~~MEDIUM~~ | ~~Documents empty state shows wrong message with no search~~ | **DONE** |
| ~~13~~ | ~~SCRUM-362~~ | ~~MEDIUM~~ | ~~Platform Disclaimer shown on Settings page instead of onboarding~~ | **DONE** (Session 26: removed from Settings, now Dashboard-only) |
| ~~14~~ | ~~SCRUM-364~~ | ~~MEDIUM~~ | ~~search.arkova.ai footer uses banned "Bitcoin" terminology~~ | **DONE** |
| ~~15~~ | ~~SCRUM-365~~ | ~~MEDIUM~~ | ~~search.arkova.ai page title is just "Arkova"~~ | **DONE** |
| ~~16~~ | ~~SCRUM-366~~ | ~~MEDIUM~~ | ~~Suggested search chips don't auto-execute search~~ | **DONE** |
| ~~17~~ | ~~SCRUM-368~~ | ~~MEDIUM~~ | ~~Admin sidebar active state wrong for Payments and Controls~~ | **DONE** |

### LOW Priority

| # | Jira | Severity | Bug | Status |
|---|------|----------|-----|--------|
| ~~18~~ | ~~SCRUM-370~~ | ~~LOW~~ | ~~About page uses initials avatars instead of real photos~~ | **DONE** (Session 26: removed broken img tags, clean initials) |
| ~~19~~ | ~~SCRUM-371~~ | ~~LOW~~ | ~~Access token visible in console error log during OAuth~~ | **DONE** |

### Already Resolved (Done in Jira)

| Jira | Bug | Resolution |
|------|-----|------------|
| ~~SCRUM-372~~ | ~~Stale refresh token error on cold load~~ | **DONE** |
| ~~SCRUM-373~~ | ~~Admin overview metric cards stuck on skeleton~~ | **DONE** |
| ~~SCRUM-378~~ | ~~Dashboard shows 0 records for admin~~ | **DONE** |
| ~~SCRUM-380~~ | ~~Compliance page shows 0 Active Credentials~~ | **DONE** |
| ~~SCRUM-385~~ | ~~GEO-13 on-page SEO keyword fix~~ | **DONE** |

---

## TIER 1D: PRODUCTION UAT BUGS (2026-04-05 Comprehensive Click-Through)

_Discovered via comprehensive UAT click-through of app.arkova.ai. 10 bugs found (3 HIGH, 4 MEDIUM, 3 LOW). Full report: `docs/bugs/uat_comprehensive_2026_04_05.md`._

### HIGH Priority

| # | ID | Severity | Bug | Status |
|---|-----|----------|-----|--------|
| 1 | UAT5-01 / SCRUM-455 | **HIGH** | Public search broken — "Search failed" on all tabs. No Supabase RPC calls made. Silent catch in SearchPage.tsx:164. | **OPEN** |
| 2 | UAT5-02 / SCRUM-456 | **HIGH** | Treasury page: "Unable to fetch balance/fee rates". Worker admin stats endpoints failing. | **OPEN** |
| 3 | UAT5-03 / SCRUM-457 | **HIGH** | Pipeline monitoring page shows all zeros — worker stats endpoints not returning data | **OPEN** |

### MEDIUM Priority

| # | ID | Severity | Bug | Status |
|---|-----|----------|-----|--------|
| 4 | UAT5-04 | **MEDIUM** | API Keys page shows "authentication_required" error card — worker usage endpoint 401 | **OPEN** |
| 5 | UAT5-05 | **MEDIUM** | Developers page: ~600px empty gap between metrics and feature cards | **OPEN** |
| 6 | UAT5-06 | **MEDIUM** | Verification page for revoked records ends abruptly — no network receipt/share/footer | **OPEN** |
| 7 | UAT5-07 | **MEDIUM** | Dashboard "12,575 records" vs Billing "Records secured: 0" — metrics inconsistency | **OPEN** |

### LOW Priority

| # | ID | Severity | Bug | Status |
|---|-----|----------|-----|--------|
| 8 | UAT5-08 | **LOW** | Attestation ARK-ATT-2026-94008AC0 stuck "Anchoring in Progress" since Mar 22 | **OPEN** |
| 9 | UAT5-09 | **LOW** | Verification page shows raw ISO 8601 date (2026-04-01T00:00:00Z) | **OPEN** |
| 10 | UAT5-10 | **LOW** | Organization page shows "— records" instead of "0 records" | **OPEN** |

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
| ~~MVP-12~~ | ~~Dark mode toggle~~ | ~~LOW~~ — **DONE** (sidebar ThemeToggle cycles light/dark/system) |

> ~~MVP-20 (LinkedIn badge integration)~~ — Superseded by BETA-09 (LinkedInShare.tsx)

### ~~P8 AI Intelligence — ALL COMPLETE (19/19)~~
_All P8 stories complete including Phase II: P8-S6 (feedback loop), P8-S8 (integrity scoring), P8-S9 (review queue), P8-S16 (AI reports). Completed via PR #80._

### GEO & SEO — 6 not started (marketing site / external tasks)
| ID | Description | Priority | Source |
|----|-------------|----------|--------|
| **GEO-13** | **On-page SEO critical fixes (title, H1, meta, keywords)** | **CRITICAL** | 2026-03-29 audit: keyword score 4/10. Requires arkova-marketing repo |
| **GEO-14** | **Fix soft 404s (nonexistent URLs return 200 + homepage)** | **CRITICAL** | 2026-03-29 audit. Requires arkova-marketing repo |
| **GEO-15** | **Image alt text + product screenshots** | **HIGH** | 2026-03-29 audit: image score 3/10. Requires arkova-marketing repo |
| **GEO-16** | **Add traction numbers / social proof to homepage** | **HIGH** | 2026-03-29 audit: 0 metrics shown. Requires arkova-marketing repo |
| **GEO-17** | **Internal linking + contextual cross-references** | **HIGH** | 2026-03-29 audit: 0 body links. Requires arkova-marketing repo |
| GEO-09 | Community & brand presence launch | MEDIUM | External tasks (ProductHunt, Reddit, G2, Crunchbase) |

### GEO & SEO — 4 partial
| ID | Description | Remaining |
|----|-------------|-----------|
| GEO-02 | LinkedIn entity + sameAs | Wikidata entry (external) |
| GEO-08 | Content expansion — 5 core pages | 5 pages needed in arkova-marketing repo |
| GEO-10 | IndexNow for Bing/Copilot | **Code + tests DONE** (11 tests). Needs INDEXNOW_KEY env var + key file on marketing site |
| ~~GEO-03~~ | ~~Publish /privacy and /terms~~ | ~~**COMPLETE** — verified 200 status 2026-03-29~~ |
| ~~GEO-04~~ | ~~About page + team bios~~ | ~~**COMPLETE** — team section + Person schema on homepage~~ |
| ~~GEO-05~~ | ~~Enhanced schema~~ | ~~**COMPLETE** — speakable + AggregateOffer deployed~~ |
| ~~GEO-12~~ | ~~Security headers~~ | ~~**COMPLETE** — vercel.json headers deployed~~ |

### GEO & SEO — NOT APPLICABLE in this repo
| ID | Description | Notes |
|----|-------------|-------|
| GEO-11 | YouTube explainers + VideoObject schema | External content creation |

### Dependency Hardening (DEP) — Release R-DEP-01 — 1/10
_Source: Dependency audit 2026-04-09 — cross-referenced [Dependency Sheet](https://docs.google.com/spreadsheets/d/1Wy_HgmsiBhaEcxoqUPjUmeG0xYstJuW2ARXFYEGXUp4) against package.json files_
_Story doc: [26_dependency_hardening.md](stories/26_dependency_hardening.md) | Jira Epic: SCRUM-550 | Release: R-DEP-01_

**Sprint 1 — Risk Reduction (P0)**

| # | ID | Priority | Story | Effort | Status |
|---|-----|----------|-------|--------|--------|
| 1 | DEP-01 | **P0** | Supabase Disaster Recovery Plan & Cold Standby | Large | NOT STARTED |
| 2 | DEP-02 | **P0** | Cloudflare Tunnel Failover Procedure | Medium | NOT STARTED |
| 3 | DEP-03 | **P0** | Document Missing Security-Critical Dependencies | Small | NOT STARTED |

**Sprint 2 — Version Currency (P1)**

| # | ID | Priority | Story | Effort | Status |
|---|-----|----------|-------|--------|--------|
| 4 | DEP-04 | **P1** | Upgrade Express to v5 | Medium | NOT STARTED |
| 5 | ~~DEP-05~~ | ~~**P1**~~ | ~~Upgrade ESLint to v9 + Flat Config~~ | ~~Medium~~ | **COMPLETE** |
| 6 | DEP-06 | **P1** | Pin Security-Critical Dependency Versions | Small | NOT STARTED |

**Sprint 3 — Operational Maturity (P2)**

| # | ID | Priority | Story | Effort | Status |
|---|-----|----------|-------|--------|--------|
| 7 | DEP-07 | **P2** | Email Delivery Monitoring (Replace Silent Failures) | Small | NOT STARTED |
| 8 | DEP-08 | **P2** | Dependency Update Cadence & Policy | Small | NOT STARTED |
| 9 | DEP-09 | **P2** | SBOM Generation in CI | Small | NOT STARTED |
| 10 | DEP-10 | **P2** | License Audit — GPL Compatibility Review | Small | NOT STARTED |

---

### International Regulatory Compliance (REG) — Release R-REG-01 — 0/28
_Source: Compliance dashboard gaps (FERPA/HIPAA) + international expansion (Kenya, Australia, South Africa, Nigeria)_
_Story doc: [29_international_compliance.md](stories/29_international_compliance.md) | Jira Epic: SCRUM-551 | Release: R-REG-01_

**Sprint 1 — Close Dashboard Gaps (P0: FERPA + HIPAA)**

| # | ID | Priority | Story | Effort | Status |
|---|-----|----------|-------|--------|--------|
| 1 | REG-01 | **P0** | FERPA Disclosure Log | Medium | NOT STARTED |
| 2 | REG-02 | **P0** | Directory Information Opt-Out | Medium | NOT STARTED |
| 3 | REG-03 | **P0** | FERPA Data Use Agreement Template | Small | NOT STARTED |
| 4 | REG-05 | **P0** | HIPAA MFA Enforcement | Medium | NOT STARTED |
| 5 | REG-06 | **P0** | HIPAA Session Timeout | Small | NOT STARTED |
| 6 | REG-07 | **P0** | HIPAA Audit Report Generator | Medium | NOT STARTED |
| 7 | REG-08 | **P0** | HIPAA BAA Template | Small | NOT STARTED |

**Sprint 2 — Shared Infrastructure + Kenya + Australia (P1)**

| # | ID | Priority | Story | Effort | Status |
|---|-----|----------|-------|--------|--------|
| 8 | REG-04 | **P1** | FERPA Requester Identity Verification | Medium | NOT STARTED |
| 9 | REG-09 | **P1** | HIPAA Breach Notification Procedure | Small | NOT STARTED |
| 10 | REG-10 | **P1** | HIPAA Emergency Access Procedure | Small | NOT STARTED |
| 11 | REG-11 | **P1** | Data Subject Rights Workflow (All jurisdictions) | Medium | NOT STARTED |
| 12 | REG-12 | **P1** | Standard Contractual Clauses Framework | Medium | NOT STARTED |
| 13 | REG-13 | **P1** | Unified Breach Notification Procedure | Small | NOT STARTED |
| 14 | REG-14 | **P1** | Jurisdiction-Specific Privacy Notices | Small | NOT STARTED |
| 15 | REG-15 | **P1** | Kenya ODPC Registration | Small | NOT STARTED |
| 16 | REG-16 | **P1** | Kenya DPIA | Medium | NOT STARTED |
| 17 | REG-17 | **P1** | Australia APP 8 Cross-Border Assessment | Medium | NOT STARTED |
| 18 | REG-18 | **P1** | Australia NDB Procedure | Small | NOT STARTED |
| 19 | REG-26 | **P1** | Compliance Dashboard Update (FERPA + HIPAA) | Medium | NOT STARTED |

**Sprint 3 — South Africa + Nigeria + Polish (P2)**

| # | ID | Priority | Story | Effort | Status |
|---|-----|----------|-------|--------|--------|
| 20 | REG-19 | **P2** | Data Correction Workflow (APP 13) | Small | NOT STARTED |
| 21 | REG-20 | **P2** | South Africa Information Regulator Registration | Small | NOT STARTED |
| 22 | REG-21 | **P2** | POPIA Section 72 Cross-Border Assessment | Medium | NOT STARTED |
| 23 | REG-22 | **P2** | South Africa Privacy Notice | Small | NOT STARTED |
| 24 | REG-23 | **P2** | Nigeria NDPC Registration | Small | NOT STARTED |
| 25 | REG-24 | **P2** | Nigeria Cross-Border Transfer SCCs | Small | NOT STARTED |
| 26 | REG-25 | **P2** | Nigeria Privacy Notice | Small | NOT STARTED |
| 27 | REG-27 | **P2** | International Framework Badges | Small | NOT STARTED |
| 28 | REG-28 | **P2** | DPO/Information Officer Designation | Small | NOT STARTED |

---

### INFRA — 1 partial (code complete, needs env vars)
| ID | Description | Remaining |
|----|-------------|-----------|
| INFRA-07 | Sentry integration | **Code + 30 tests DONE**. Needs SENTRY_AUTH_TOKEN + SENTRY_DSN in Vercel + Cloud Run env vars |

### Compliance Mapping Layer (CML) — 5 not started
_Source: [Strategic Blueprint — The Immutable Compliance Fabric](https://docs.google.com/document/d/1yLGX5zJ6xWu_J2J-510n0yQZZe9YfzLTK_h7wm3mqyQ/edit) | Story doc: [19_compliance_mapping.md](stories/19_compliance_mapping.md) | Jira Epic: SCRUM-263_

| # | ID | Priority | Description | Dependencies | Effort |
|---|-----|----------|-------------|-------------|--------|
| 1 | ~~CML-01~~ | ~~HIGH~~ | ~~Compliance badges on verifications (SOC 2, GDPR, FERPA, ISO 27001, eIDAS control tags)~~ | ~~None~~ | ~~Medium~~ — **COMPLETE** (ComplianceBadge.tsx, complianceMapping.ts, 16 tests) |
| 2 | ~~CML-02~~ | ~~HIGH~~ | ~~Regulatory control IDs in Bitcoin anchor metadata~~ | ~~CML-01~~ | ~~Large~~ — **COMPLETE** (migration 0137, worker complianceMapping.ts, anchor.ts + batch-anchor.ts, 10 tests) |
| 3 | ~~CML-03~~ | ~~HIGH~~ | ~~Audit-ready PDF export for GRC platforms (Vanta, Drata, Anecdotes)~~ | ~~CML-01, CML-02~~ | ~~Large~~ — **COMPLETE** (audit-export.ts, PDF + CSV, single + batch, 12 tests) |
| 4 | ~~CML-04~~ | ~~MEDIUM~~ | ~~Compliance dashboard & audit readiness scoring~~ | ~~CML-01~~ | ~~Medium~~ — **COMPLETE** (framework coverage, gap analysis, export panel) |
| ~~5~~ | ~~CML-05~~ | ~~MEDIUM~~ | ~~GRC platform API integrations (Vanta, Drata, Anecdotes)~~ | ~~CML-03~~ | ~~XL~~ — **COMPLETE** (migration 0139, 3 adapters, 6 API endpoints, sync service, 27 tests) |

**Strategic value:** Transforms Arkova from verification utility to enterprise compliance infrastructure. Targets CRO/GRC teams. Justifies premium Enterprise pricing tier.

### Verifiable AI (VAI) — Phase III Roadmap — 3 complete, 2 not started
_Source: [Strategic Blueprint — The Immutable Compliance Fabric](https://docs.google.com/document/d/1yLGX5zJ6xWu_J2J-510n0yQZZe9YfzLTK_h7wm3mqyQ/edit) | Story doc: [20_verifiable_ai.md](stories/20_verifiable_ai.md) | Jira Epic: SCRUM-264_

| # | ID | Priority | Description | Dependencies | Effort |
|---|-----|----------|-------------|-------------|--------|
| ~~1~~ | ~~VAI-01~~ | ~~HIGH~~ | ~~Verifiable extraction — cryptographic binding of AI output to source hash~~ | ~~P8 AI pipeline~~ | ~~Large~~ | **COMPLETE** — migration 0138, extraction-manifest.ts, provenance endpoint, 19 tests |
| 2 | VAI-02 | MEDIUM | ZK-STARK evidence packages (zero-knowledge proofs for AI execution) | VAI-01 | XL |
| ~~3~~ | ~~VAI-03~~ | ~~HIGH~~ | ~~AI accountability report — one-click provenance export~~ | ~~VAI-01~~ | ~~Medium~~ | **COMPLETE** — PDF + JSON provenance report, lifecycle timeline, 7 tests |
| ~~4~~ | ~~VAI-04~~ | ~~HIGH~~ | ~~Auditor mode toggle — enterprise auditor view~~ | ~~None~~ | ~~Small~~ | **COMPLETE** — `useAuditorMode` hook, sidebar toggle, AppShell banner, SecureDocumentDialog suppressed |
| 5 | VAI-05 | MEDIUM | Sales deck & GTM — "Audit-Defense" positioning | None | Small |

**Strategic value:** Algorithmic Non-Repudiation — the "White Box" for AI. Solves the AI Black Box problem. Justifies $200k/year Enterprise tier. Targets CRO.

### ATS & Background Check Integration — 8/8 COMPLETE
_Story doc: [18_ats_background_checks.md](stories/18_ats_background_checks.md) | Completed 2026-03-29 | Jira: SCRUM-250–258, Epic SCRUM-18_

All 8 stories implemented:
- **ATT-01:** EmploymentVerificationForm.tsx (consent tracking, salary band, bulk CSV)
- **ATT-02:** EducationVerificationForm.tsx (14 degree types, GPA, honors, QR code)
- **ATT-03:** `POST /api/v1/attestations/batch-verify` (max 100, API key auth, rate limited)
- **ATT-04:** ATS webhooks — Greenhouse, Lever, generic HMAC verification (`/api/v1/webhooks/ats/:provider`)
- **ATT-05:** Credential portfolios — `PublicPortfolioPage.tsx`, migration 0134 `credential_portfolios` table
- **ATT-06:** EvidenceUpload.tsx (drag-drop, SHA-256 fingerprinting, max 10 files)
- **ATT-07:** OpenAPI spec documented (all endpoints in `docs/api/openapi.yaml`)
- **ATT-08:** `attestationExpiry.ts` cron job (30d/7d/expiry alerts, webhook events)

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
| 4 | ~~DEMO-04~~ | ~~**LOW**~~ | ~~Credential template visual rendering — upgrade CredentialRenderer to show diploma-style visual cards for different credential types (degree, license, certificate).~~ | **COMPLETE** (PRs #117-120, 16 templates in production, type-specific visual cards) |

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

## TIER 0: PHASE 1.5 — FOUNDATION (Active Sprint, 2026-03-22)

> Source: Arkova-Master-Strategy-Complete, Verification-Bootstrap-Deep-Dive, Verified-Intelligence-SLM-Analysis
> Story doc: [17_phase1_5_foundation.md](./stories/17_phase1_5_foundation.md)

**Priority order — all items are immediate needs:**

| ID | Story | Priority | Status | Sprint | Depends On |
|----|-------|----------|--------|--------|------------|
| ~~PH1-UI-01~~ | ~~Design system refresh (match arkova.ai)~~ | P0 | **COMPLETE** | S1 | — |
| ~~PH1-DATA-01~~ | ~~EDGAR full-text fetcher enhancement~~ | P0 | **COMPLETE** | S5 | Migration 0077 |
| ~~PH1-DATA-06~~ | ~~OpenAlex academic paper fetcher~~ | P1 | **COMPLETE** | S5 | Migration 0077 |
| ~~PH1-DATA-02~~ | ~~USPTO patent fetcher~~ | P0 | **COMPLETE** | S1 | Migration 0077 |
| ~~PH1-DATA-04~~ | ~~Merkle batch anchoring for public records~~ | P0 | **COMPLETE** | S2 | PH1-DATA-01 |
| ~~PH1-PAY-01~~ | ~~x402 Express middleware integration~~ | P0 | **COMPLETE** | S2 | Migration 0078 |
| ~~PH1-DATA-03~~ | ~~Federal Register fetcher~~ | P1 | **COMPLETE** | S2 | Migration 0077 |
| ~~PH1-INT-01~~ | ~~Vector DB enhancement for public records~~ | P0 | **COMPLETE** | S3 | Migration 0077 |
| ~~PH1-INT-02~~ | ~~RAG retrieval endpoint (Nessie query)~~ | P0 | **COMPLETE** | S3 | PH1-INT-01 |
| PH1-PAY-02 | Self-hosted x402 facilitator | P0 | **PARTIAL** — flag enabled, needs USDC address + facilitator deploy | S3 | PH1-PAY-01 |
| ~~PH1-INT-03~~ | ~~Gemini RAG integration~~ | P1 | **COMPLETE** | S4 | PH1-INT-02 |
| ~~PH1-SDK-01~~ | ~~TypeScript SDK (@arkova/sdk)~~ | P1 | **COMPLETE** | S4 | PH1-PAY-01 |
| ~~PH1-SDK-03~~ | ~~MCP server enhancement (nessie tools)~~ | P1 | **COMPLETE** | S4 | PH1-INT-02 |
| ~~PH1-DATA-05~~ | ~~Pipeline monitoring dashboard~~ | P1 | **COMPLETE** | S4 | PH1-DATA-01 |
| ~~PH1-PAY-03~~ | ~~Payment analytics & revenue tracking~~ | P1 | **COMPLETE** | S4 | PH1-PAY-01 |
| ~~PH1-SDK-02~~ | ~~Python SDK (arkova-python)~~ | P2 | **COMPLETE** | S5 | PH1-PAY-01 |

**PR #127 merged 2026-03-22:** Sprints 1-4 complete (12/15 stories). PRs #125, #126 superseded and closed.
**Remaining:** PH1-PAY-02 (facilitator deploy), PH1-SDK-02 (Python SDK)

---

## TIER 0B: AI INFRASTRUCTURE SPRINT (Session 12 — 2026-03-23) — ALL COMPLETE

> Source: Session 12 PRs #4-10 (7 PRs merged). Builds on P8 AI Intelligence (19/19 complete).

| ID | Story | Priority | Status | Detail |
|----|-------|----------|--------|--------|
| AI-EVAL-01 | Golden dataset + scoring engine | P0 | **COMPLETE** | 1,330 entries (8 phases), F1/precision/recall per field, eval runner, 447 tests |
| AI-EVAL-02 | Live Gemini eval baseline | P0 | **COMPLETE** | F1=82.1%, confidence r=0.426, ECE=13.5%. Best: CLE 94.3%, Worst: SEC_FILING 36.8% |
| AI-PROMPT-01 | Prompt version tracking | P1 | **COMPLETE** | Prompt hash stored with every extraction event (migration 0092) |
| AI-PROMPT-02 | Few-shot expansion | P1 | **COMPLETE** | 11→130 examples, covering all 21 credential types + OCR-corrupted documents |
| AI-FRAUD-01 | Fraud audit framework | P1 | **COMPLETE** | CLI framework, 0 flagged items in prod (integrity scoring not yet active) |
| AI-OBS-01 | Admin AI metrics dashboard | P1 | **COMPLETE** | /admin/ai-metrics: usage, feedback, provider stats, eval baseline |

**Also in Session 12:**
- Anchoring throughput 110x: confirm job 10→50 tx groups (~1,100 confirms/run), Merkle batch 500→2,000
- Pipeline credential types: migration 0091 adds SEC_FILING, PATENT, REGULATION, PUBLICATION
- ExtractedFieldsSchema: CLE fields + fraudSignals added (was silently rejecting Gemini responses)
- Pipeline metadata display: arrays formatted, nulls hidden

---

## TIER 0F: GEMINI GOLDEN EVOLUTION (GME2) — ACTIVE 2026-04-16

> **Correction (2026-04-16):** The original GME epic (SCRUM-612) was premised on a June 17 `gemini-2.5-flash` deprecation. Prod extraction is actually on **gemini-2.0-flash tuned (v5-reasoning, `endpoints/8811908947217743872`)** — no 2.5 deadline pressure. The real Gemini evolution happened via GME2.
> **Active Jira Epic:** SCRUM-772 (GME2) | Child stories SCRUM-792–796
> **Domain-expert epics (gated on v7 + GME8):** SCRUM-820 GME3 Legal, SCRUM-821 GME4 Financial, SCRUM-823 GME5 Trades
> **Story doc:** [28_gemini_migration_evolution.md](stories/28_gemini_migration_evolution.md) (being rewritten 2026-04-16 to match v5/v6/v7 arc)
> **Status:** SCRUM-612 (original GME epic) and its 17 children (SCRUM-613–617, 618–628) remain open in Jira but are **strategically superseded** — all future Gemini work flows through SCRUM-772 / 820 / 821 / 823.

### Phase 1: Emergency Migration (MUST ship before June 17)

| ID | Story | Priority | Status | Effort |
|----|-------|----------|--------|--------|
| GME-01 | Centralize all model references into config | P0 | NOT STARTED | Small |
| GME-02 | Migrate to Gemini 3 Flash (extraction + fraud) | P0 | NOT STARTED | Medium |
| GME-03 | Migrate embedding model (eval gemini-embedding-2) | P0 | NOT STARTED | Small |
| GME-04 | Tuned model migration (90.4% F1 at risk) | P0 | NOT STARTED | Large |
| GME-05 | Deprecation monitoring & alerts | P1 | NOT STARTED | Small |

### Phase 2: Eval & Quality Assurance

| ID | Story | Priority | Status | Effort |
|----|-------|----------|--------|--------|
| GME-06 | Full golden dataset eval on Gemini 3 (1,605 entries) | P0 | NOT STARTED | Medium |
| GME-07 | Fraud detection eval on Gemini 3 vision | P1 | NOT STARTED | Small |
| GME-08 | Embedding quality benchmark (100-query NDCG) | P1 | NOT STARTED | Small |

### Phase 3: Training Infrastructure Update

| ID | Story | Priority | Status | Effort |
|----|-------|----------|--------|--------|
| GME-09 | Update all training/eval scripts to Gemini 3 | P1 | NOT STARTED | Medium |
| GME-10 | Gemini Golden v2 retrain on Gemini 3 base | P0 | NOT STARTED | Large |
| GME-11 | Gemini Golden v3 — expanded dataset (2,000+) | P1 | NOT STARTED | Large |

### Phase 4-6: Advanced, Optimization, Future-Proofing

| ID | Story | Priority | Status | Effort |
|----|-------|----------|--------|--------|
| GME-12 | Multimodal embedding for document images | P2 | NOT STARTED | Medium |
| GME-13 | Enhanced fraud detection with Gemini 3 vision | P1 | NOT STARTED | Medium |
| GME-14 | Structured output schema validation | P1 | NOT STARTED | Small |
| GME-15 | Context window optimization | P2 | NOT STARTED | Medium |
| GME-16 | Latency & cost benchmarking (Gemini 3 vs 2.5) | P1 | NOT STARTED | Small |
| GME-17 | Batch processing optimization | P2 | NOT STARTED | Medium |
| GME-18 | Flash Lite for lightweight tasks | P2 | NOT STARTED | Small |
| GME-19 | Multi-model fallback chain | P2 | NOT STARTED | Medium |
| GME-20 | Model version pinning | P1 | NOT STARTED | Small |

### Phase 7: Extraction Quality — Templates & Labeling (shipped in v1.4.0)

| ID | Story | Priority | Status | Effort |
|----|-------|----------|--------|--------|
| ~~GME-21~~ | ~~Credential type parity (align 23 UI vs 20 extraction)~~ | P0 | **DONE** (SCRUM-629, v1.4.0) | Medium |
| ~~GME-22~~ | ~~Expand starter templates (3 → 23 types)~~ | P1 | **DONE** (SCRUM-630, v1.4.0) | Medium |
| ~~GME-23~~ | ~~Type-specific field validation (stop cross-contamination)~~ | P1 | **DONE** (SCRUM-631, v1.4.0) | Medium |
| ~~GME-24~~ | ~~Fraud signal calibration (stop over-flagging)~~ | P0 | **DONE** (SCRUM-632, v1.4.0) | Medium |
| ~~GME-25~~ | ~~Smart type suggestion for OTHER (reduce catch-all)~~ | P1 | **DONE** (SCRUM-633, v1.4.0) | Small |
| GME-26 | Template reconstruction quality gate | P1 | NOT STARTED (SCRUM-634, R-GME-01) | Small |

**Cost:** ~$195 | **Risk:** Fine-tuning may not be available for Gemini 3 by June — fallback is few-shot prompting

---

## TIER 0G: INTEGRATION SURFACE & PACKAGING (INT) — 8/9 DONE (2026-04-16 reconciled)

> **Source:** Arkova Integration Strategy v2 (Google Doc `1wP7pkOmf7rVdStIHaA9V4QxKPg4hoVB6`)
> **Jira Epic:** SCRUM-641 | **Stories:** SCRUM-642–650
> **Story doc:** [31_integration_surface.md](stories/31_integration_surface.md)
> **Status (2026-04-16):** 8 of 9 shipped. Last gap is INT-09 Webhook CRUD route (file `services/worker/src/routes/webhooks.ts` does not yet exist). Close epic after INT-09 lands.

### R-INT-01: YC Demo Critical

| ID | Jira | Story | Pts | Status |
|----|------|-------|-----|--------|
| ~~INT-01~~ | ~~SCRUM-642~~ | ~~TypeScript SDK (`@arkova/sdk`)~~ | ~~5~~ | **DONE** (`sdks/typescript/`) |
| ~~INT-02~~ | ~~SCRUM-643~~ | ~~MCP Server Tool Enhancement~~ | ~~3~~ | **DONE** |
| ~~INT-03~~ | ~~SCRUM-644~~ | ~~Embeddable Verification Bundle (`embed.js`)~~ | ~~5~~ | **DONE** (`public/embed.js`, `dist/embed.js`) |
| **INT-09** | **SCRUM-645** | **Webhook CRUD via API** | 3 | **NOT STARTED** — last INT gap. `services/worker/src/routes/webhooks.ts` missing. See Sprint 4 in `docs/SPRINT_PLAN_2026-Q2.md`. |

### R-INT-02: SDK & Automation

| ID | Jira | Story | Pts | Status |
|----|------|-------|-----|--------|
| ~~INT-04~~ | ~~SCRUM-646~~ | ~~Python SDK (`arkova-python`)~~ | ~~3~~ | **DONE** (`sdks/python/arkova/client.py`) |
| ~~INT-05~~ | ~~SCRUM-647~~ | ~~Zapier / Make.com Integration~~ | ~~5~~ | **DONE** (per memory) |

### R-INT-03: Vertical Connectors

| ID | Jira | Story | Pts | Status |
|----|------|-------|-----|--------|
| ~~INT-06~~ | ~~SCRUM-648~~ | ~~Clio (Law Firm DMS)~~ | ~~8~~ | **DONE** |
| ~~INT-07~~ | ~~SCRUM-649~~ | ~~Bullhorn Marketplace App~~ | ~~8~~ | **DONE** |
| ~~INT-08~~ | ~~SCRUM-650~~ | ~~Screening Report Embed Template~~ | ~~3~~ | **DONE** |

**Total INT epic:** 43 points | **9 stories / 8 done / 1 open** | Close epic after INT-09.

---

## TIER 0H: NESSIE VERIFICATION INFRASTRUCTURE (NVI) — HIGHEST PRIORITY (2026-04-16)

> **Jira Epic:** SCRUM-804 | **LLM-as-judge child:** SCRUM-816 (NVI-12)
> **Priority:** **HIGHEST — gates all further Nessie regulation training**

**Why this epic exists:** The 2026-04-16 A/B/C test proved FCRA citation accuracy improved 0%→57% via (a) canonical-ID convention (+30.5pp) and (b) hand-crafted scenario expansion (+14pp). But the underlying question — _"is the training data accurate?"_ — has no answer. Statute quotes, case numbers, agency bulletin references, and state cites in the 89-source FCRA registry and 277 training scenarios have NOT been verified against authoritative text. A Nessie deployed on unverified data is not just inaccurate — it's professionally dangerous for a compliance officer relying on its citations.

**Decree:** **NDD (SCRUM-770) / NSS (SCRUM-771) / NTF (SCRUM-769) are PAUSED** until FCRA passes the NVI verification + benchmark gate. v28 HIPAA and v29 FERPA are **quarantined** until FCRA proves the verification pipeline works.

### Phase 1 — FCRA Source Verification Pipeline

| ID | Story | Priority | Status | Effort |
|----|-------|----------|--------|--------|
| NVI-01 | Statute-quote validator (Cornell LII / eCFR diff) | **Highest** | NOT STARTED | Medium |
| NVI-02 | Case-law citation validator (Google Scholar Case Law) | **Highest** | NOT STARTED | Medium |
| NVI-03 | Agency-bulletin validator (CFPB / FTC / HHS OCR / DoE) | **Highest** | NOT STARTED | Medium |
| NVI-04 | State-statute validator (state legislature DBs) | High | NOT STARTED | Medium |
| NVI-05 | FCRA source registry audit + quarantine | **Highest** | NOT STARTED | Small |

### Phase 2 — Chain-of-Thought + Distillation + Benchmark

| ID | Story | Priority | Status | Effort |
|----|-------|----------|--------|--------|
| NVI-06 | Chain-of-thought retrofit on all FCRA scenarios | **Highest** | NOT STARTED | Medium |
| NVI-07 | Claude Opus distillation → 5k verified FCRA Q&A | **Highest** | NOT STARTED | Medium (~$200 API) |
| NVI-08 | Multi-turn + document-grounded scenarios | High | NOT STARTED | Medium |
| NVI-09 | Adversarial + "I don't know" training | High | NOT STARTED | Medium |
| NVI-10 | Attorney-reviewed gold-standard benchmark (50 Q) | **Highest** | NOT STARTED | Large ($2–5K counsel) |
| NVI-11 | Production canary (5% FCRA queries) + feedback loop | High | NOT STARTED | Medium |
| SCRUM-816 / NVI-12 | LLM-as-judge benchmark runner (Claude / GPT-4o / Gemini 2.5 Pro) | High | NOT STARTED | Medium |

**DoD (epic-level):** All FCRA quotes / cites / bulletins verified (or quarantined); CoT on every scenario; 5K distilled Q&A; 50-Q attorney-reviewed benchmark; Nessie ≥ Gemini 2.5 Pro on benchmark; 5% production canary live.

**Cost + timeline:** ~$3,300–$7,300 (mostly attorney review), 3–4 weeks.

---

## TIER 0I: API RESPONSE RICHNESS (API-RICH) — NEW 2026-04-16

> **Source:** 2026-04-16 API surface audit against `src/types/database.types.ts`. Current `/verify/{publicId}`, `/ai/extract`, `/attestations/{publicId}` return ~15 fields; DB stores 30+ per anchor plus linked manifests, audit events, extraction_manifests. Quick wins are all backwards-compatible nullable additions.
> **Story doc:** `docs/stories/NN_api_response_richness.md` (to be written in Sprint 1)
> **Priority:** High — highest ROI per engineering hour on the backlog.

| ID | Story | Priority | Status | Effort |
|----|-------|----------|--------|--------|
| API-RICH-01 | `/verify/{publicId}` expose `compliance_controls`, `chain_confirmations`, `parent_anchor_id`, `revocation_tx_id/block`, `file_mime/size` | **High** | NOT STARTED | Medium |
| API-RICH-02 | `/ai/extract` + `/verify/{publicId}` expose per-field `confidence_scores`, `subType`, `description`, `fraudSignals` | High | NOT STARTED | Small |
| API-RICH-03 | New `GET /anchor/{publicId}/lifecycle` returning chain-of-custody from `audit_events` | High | NOT STARTED | Medium |
| API-RICH-04 | `/attestations/{publicId}` include evidence array (not count-only) + attestor chain | Medium | NOT STARTED | Small |
| API-RICH-05 | New `GET /anchor/{publicId}/extraction-manifest` exposing `zk_proof`, `manifest_hash`, prompt version (VAI-01 storage surfaced) | Medium | NOT STARTED | Medium |

**Principle:** zero model risk; already-stored data becomes API-visible. All additions are nullable in response schema; no breaking changes. OpenAPI spec + Zod + SDK (TS + Python) must update together.

---

## TIER 0J: NESSIE CONTRACT EXPERTISE (CONT) — NEW 2026-04-16

> **Jira Epic:** SCRUM-874 | **Priority:** High | **Blocked by:** SCRUM-804 (NVI FCRA gate)
> **Story doc:** to be written at `docs/stories/40_nessie_contract_expertise.md` (scoped, not yet committed)
> **User directive (2026-04-16):** _"Nessie needs to be experts on contracts as well. Contracts are key as we expand to e-signatures and highly regulated markets."_

**Why this exists:** Arkova has best-in-class contract-**integrity** (Bitcoin anchoring + Phase 3 AdES + compliance tagging) but no contract-**reasoning** intelligence. A compliance officer cannot ask Nessie "is this BAA missing required §164.504 provisions? is this click-wrap ESIGN-enforceable in Illinois? does this SCC 2021 Module 2 apply here?"

### Children (seeded 2026-04-16)

| ID | Jira | Story | Effort | Status |
|----|------|-------|--------|--------|
| CONT-01 (seed) | SCRUM-791 | Contract law fundamentals (US / UK / common law / BAA / DUA / DPA / SCC) — re-parented from NDD | Large | Open (was Medium; raised to High) |
| CONT-02 | SCRUM-876 | ESIGN Act + UETA state variations + eIDAS → AdES mapping | Large (~4w) | Open |
| CONT-03 | SCRUM-877 | Clause-risk detection — 30–50 patterns (liability, indemnity, assignment, non-compete, auto-renewal, IP/WFH, arbitration, MFN) | Large (~3w) | Open |
| CONT-04 | SCRUM-878 | FERPA §99.31(a)(6) DUA scenarios (currently **0** in v29.0 training) | Medium (~2w) | Open |

Additional child stories to be created later for the remaining CONT epic phases (AdES lifecycle reasoning, GDPR SCC 2021 module selection, contract formation edge cases).

---

## TIER 0K: NESSIE FEDERAL CONTRACTING (FEDCONT) — NEW 2026-04-16

> **Jira Epic:** SCRUM-875 | **Priority:** High | **Blocked by:** SCRUM-804 (NVI) — except SAM.gov fetcher which is pipeline/infrastructure
> **Strategic rationale:** $700B+ annual federal procurement market with heavy compliance obligations that map naturally to Arkova's anchoring + audit-ready-export stack. GovCon prospects have procurement budget and need paper trails for DCAA / OIG / IG audits.

### Children (seeded 2026-04-16)

| ID | Jira | Story | Effort | Status |
|----|------|-------|--------|--------|
| FEDCONT-01 | SCRUM-879 | FAR Part 52 + DFARS 252 mandatory-clause library + flowdown classification | XL (~6w) | Open |
| FEDCONT-02 | SCRUM-880 | SAM.gov UEI lookup + active-registration status validation (pipeline fetcher — NOT NVI-gated) | Medium (~2w) | Open |
| FEDCONT-03 | SCRUM-881 | SBA set-asides + size-standards classifier (8(a), HUBZone, SDVOSB, WOSB) | Large (~3w) | Open |

Additional FEDCONT phases queued: CMMC Level detection (DFARS 252.204-7012/-7019/-7020), 2 CFR 200 Uniform Guidance, Davis-Bacon / SCA wage determinations, TINA certification thresholds, CAS coverage classification.

---

## TIER 0L: GEMINI CONTRACT-TYPE MIGRATION (GME2-06) — NEW 2026-04-16

> **Jira:** SCRUM-882 | **Parent epic:** SCRUM-772 (GME2) | **NOT blocked by NVI** (Gemini extraction work, not Nessie training)

Prerequisite for CONT epic (SCRUM-874) Phase 3+: Gemini needs a `CONTRACT` `credential_type` to emit at extraction time. Multi-step work per CLAUDE.md Migration Procedure:

1. Migration 0216 `ALTER TYPE credential_type ADD VALUE IF NOT EXISTS 'CONTRACT'`
2. TS types regeneration (`npx supabase gen types`)
3. `src/lib/validators.ts` — add CONTRACT + sub-types (msa, sow, nda, baa, dpa, scc, dua, employment, federal_prime, federal_subcontract, saas_order, license_agreement, settlement_bilateral, loi, mou, amendment)
4. `services/worker/src/ai/prompts/extraction-v6.ts:29` — add CONTRACT to enumerated credentialType list
5. Consumer file sweep (40+ files reference CREDENTIAL_TYPES; TS compiler catches most)
6. 5–10 CONTRACT seed exemplars in v7 golden dataset

**Dedup check:** `operating_agreement` already exists under `BUSINESS_ENTITY` sub-types — do NOT duplicate under CONTRACT; cross-reference from story doc.

---

## TIER 0D: NESSIE MODEL TRAINING & EVALUATION (Session 19 — 2026-03-30)

> Source: Model comparison eval (MLX 4-bit, 50 samples). Story doc: [21_nessie_model_training.md](stories/21_nessie_model_training.md)
> Jira Epic: SCRUM-312 | Stories: SCRUM-334–339
> Depends on: AI-EVAL-01, AI-EVAL-02, P8 AI Intelligence (all complete)
> Blocked by: RunPod/Together AI GPU capacity (external)

**Context:** Three fine-tuned Nessie models evaluated 2026-03-30 via local MLX 4-bit quantized inference. All scored below Gemini production baseline (82.1% F1). Gemini Golden fine-tuned model trained on Vertex AI but never evaluated — highest-priority target.

| ID | Story | Priority | Status | Dependencies | Effort |
|----|-------|----------|--------|-------------|--------|
| ~~NMT-01~~ | ~~Gemini Golden fine-tuned eval~~ | ~~P0~~ | **COMPLETE** — Weighted F1=90.4% (+8.3pp vs baseline), recommend as prod default | Vertex AI access | Small |
| ~~NMT-02~~ | ~~JSON comment stripping in extraction parser~~ | ~~P1~~ | **COMPLETE** — `stripJsonComments()` utility + 10 tests, integrated in nessie/gemini/eval | None | Small |
| ~~NMT-03~~ | ~~Nessie confidence recalibration~~ | ~~P1~~ | **COMPLETE** — Piecewise linear calibration (8 knots), provider offset fix. PR #225 | NMT-01 | Medium |
| ~~NMT-04~~ | ~~Full-precision GPU eval (fp16/bf16)~~ | ~~P1~~ | **COMPLETE** — v5: 87.2% F1, v4: 65.6% F1. fp16 ≈ 4-bit (no quality diff). RunPod A6000 48GB. | None | Medium |
| ~~NMT-05~~ | ~~Upload model weights to HuggingFace~~ | ~~P2~~ | **COMPLETE** — upload script + model card + 18 tests. PR #372 | HF token | Medium |
| ~~NMT-06~~ | ~~Nessie v5 training + condensed prompt~~ | ~~P2~~ | **COMPLETE** — v5 trained (1,903 train), 87.2% F1, condensed prompt deployed to provider | NMT-01, NMT-03 | Large |
| ~~NMT-07~~ | ~~Nessie intelligence training pipeline~~ | ~~P0~~ | **COMPLETE** — Pipeline + prompts + 34 tests. Intelligence distillation v2 ready. | Public records corpus | Large |
| ~~NMT-08~~ | ~~Gemini Golden v2 — full dataset retrain~~ | ~~P1~~ | **COMPLETE** — Script updated with phases 10-11 + realistic confidence. | Vertex AI access | Small |
| ~~NMT-09~~ | ~~Deploy Nessie v5 to RunPod~~ | ~~P0~~ | **COMPLETE** — Deployment script + smoke test + 13 tests. PR #372 | RunPod API | Small |
| ~~NMT-10~~ | ~~Execute HuggingFace upload~~ | ~~P0~~ | **COMPLETE** — v5 + intelligence upload scripts + 18 tests. PR #372 | HF token | Small |
| ~~NMT-11~~ | ~~Intelligence distillation (500+ examples)~~ | ~~P0~~ | **COMPLETE** — Gemini teacher distillation pipeline + 22 tests. PR #372 | Gemini API | Large |
| ~~NMT-12~~ | ~~Fine-tune Nessie v6 intelligence~~ | ~~P0~~ | **COMPLETE** — v6 fine-tune submission script + validation + 11 tests. PR #372 | NMT-11 | Medium |
| ~~NMT-13~~ | ~~Automated eval regression pipeline~~ | ~~P1~~ | **COMPLETE** — Baseline metrics + regression checks + 18 tests. PR #371 | NMT-09 | Medium |
| ~~NMT-14~~ | ~~Golden dataset phase 14 (rare types)~~ | ~~P1~~ | **COMPLETE** — 120 entries (CHARITY, ACCREDITATION, BADGE, ATTESTATION, MEDICAL) + 14 tests. PR #371 | None | Medium |
| ~~NMT-15~~ | ~~Nessie v7 extraction retrain~~ | ~~P1~~ | **COMPLETE** — v7 export script + Together AI submission + 15 tests. PR #372 | NMT-14 | Medium |
| ~~NMT-16~~ | ~~Domain adapter routing~~ | ~~P2~~ | **COMPLETE** — 6 domains (4 trained + 2 placeholder), typed Sets, fallback + 28 tests. PR #371 | NMT-15 | Large |

**Eval Results (2026-03-31, updated with v5 fp16):**

| Model | Macro F1 | Weighted F1 | Conf Corr | ECE | Notes |
|-------|----------|-------------|-----------|-----|-------|
| **Nessie v5 (fp16)** | 75.7% | **87.2%** | **0.539** | 11.0% | **NEW — 3.5x faster than Gemini, zero cost** |
| **Gemini Golden (tuned)** | 81.4% | **90.4%** | 0.426 | **9.5%** | Prod default (API) |
| Gemini (production) | **82.1%** | ~82% | 0.426 | ~10% | Base baseline |
| Nessie v4 (fp16) | 52.2% | 65.6% | 0.167 | 24.3% | RunPod A6000, 100 samples |
| Nessie v3 (4-bit) | 56.4% | 58.4% | 0.214 | 44.6% | MLX 4-bit, 50 samples |

**Key findings:** Nessie v5 achieves 87.2% weighted F1 (+21.6pp over v4), only 3.2pp behind Gemini Golden. v5 confidence correlation (0.539) exceeds Gemini (0.426). fp16 ≈ 4-bit quantization (model quality is bottleneck, not precision). Fine-tuned models MUST use condensed prompt (full 58K prompt = 0% F1).

**CRITICAL ROLE DISTINCTION (2026-04-03):** Gemini Golden = metadata extraction engine (templates, fields, fraud). Nessie = compliance intelligence engine (analyzes documents, makes recommendations with verified citations). Nessie v5 was trained as extraction — NMT-07 pivots to intelligence training data. See strategy docs: Arkova-Verified-Intelligence-SLM-Analysis, Arkova Strategic Blueprint.

---

## TIER 0E: NESSIE COMPLIANCE ENGINE (NCE) — Session 39+

> Source: Strategic Blueprint, SLM Analysis, Verification Bootstrap Strategy
> Jira Epic: SCRUM-590 | Stories: SCRUM-591–611 (SCRUM-599 closed as duplicate of SCRUM-598)
> Jira Release: **R-NCE-01 Nessie Compliance Engine v1** (20 open stories + epic)
> Story doc: [27_nessie_compliance_engine.md](stories/27_nessie_compliance_engine.md)
> Depends on: NMT-07 (intelligence pipeline), Phase 1.5 RAG, 320K+ public records

**Vision:** Nessie becomes the compliance copilot every org needs — reads anchored documents, gives jurisdiction-aware compliance scores, identifies missing documents, generates audit-ready reports. Every recommendation backed by Bitcoin-anchored evidence.

### Phase 1: Train Intelligence Model (Weeks 1-3)

| ID | Story | Priority | Status | Effort |
|----|-------|----------|--------|--------|
| NCE-01 | Enable embedding corpus (320K+ records) | P0 | NOT STARTED | Small |
| NCE-02 | Gemini Golden v2 retrain (1,605 entries) | P0 | NOT STARTED | Small |
| NCE-03 | Distill intelligence training data (1,150+ examples) | P0 | NOT STARTED | Large |
| NCE-04 | Fine-tune Nessie Intelligence v1 | P0 | NOT STARTED | Medium |
| NCE-05 | Intelligence eval benchmark (100 Q&A) | P0 | NOT STARTED | Medium |

### Phase 2: Compliance Scoring Engine (Weeks 3-5)

| ID | Story | Priority | Status | Effort |
|----|-------|----------|--------|--------|
| NCE-06 | Jurisdiction rule engine (10 US states) | P0 | NOT STARTED | Large |
| NCE-07 | Compliance score calculator (0-100, A-F) | P0 | NOT STARTED | Large |
| NCE-08 | Gap detector — "What's missing?" | P0 | NOT STARTED | Medium |
| NCE-09 | Expiry & renewal alerts | P1 | NOT STARTED | Medium |

### Phase 3: Frontend Intelligence UI (Weeks 5-7)

| ID | Story | Priority | Status | Effort |
|----|-------|----------|--------|--------|
| NCE-10 | Compliance dashboard (score + gaps + recs) | P0 | NOT STARTED | Large |
| NCE-11 | Nessie chat interface (Q&A with citations) | P1 | NOT STARTED | Large |
| NCE-12 | Compliance score widget on org dashboard | P1 | NOT STARTED | Small |

### Phase 4: DPO + Advanced Training (Weeks 6-8)

| ID | Story | Priority | Status | Effort |
|----|-------|----------|--------|--------|
| NCE-13 | DPO training for citation accuracy (>98%) | P1 | NOT STARTED | Large |
| NCE-14 | Jurisdiction-specific LoRA adapters (CA, NY, Fed) | P1 | NOT STARTED | Large |
| NCE-15 | Cross-reference engine (doc consistency) | P1 | NOT STARTED | Medium |

### Phase 5: Enterprise & Scale (Weeks 8-12)

| ID | Story | Priority | Status | Effort |
|----|-------|----------|--------|--------|
| NCE-16 | Compliance API (programmatic access) | P1 | NOT STARTED | Medium |
| NCE-17 | Industry benchmarking (anonymous compare) | P2 | NOT STARTED | Medium |
| NCE-18 | Audit-ready reports (SOC 2/FERPA/HIPAA) | P1 | NOT STARTED | Large |
| NCE-19 | Nessie MCP tools for agent frameworks | P2 | NOT STARTED | Medium |
| NCE-20 | Upload Intelligence model to HuggingFace | P2 | NOT STARTED | Small |

### Phase 6: Self-Improving (Months 3-6)

| ID | Story | Priority | Status | Effort |
|----|-------|----------|--------|--------|
| NCE-21 | Feedback loop — learn from user actions | P2 | NOT STARTED | Large |
| NCE-22 | Corpus expansion (320K → 1M+) | P2 | NOT STARTED | Medium |
| NCE-23 | Client-side Nessie (WebLLM, 1-3B) | P3 | NOT STARTED | XL |

**Cost:** ~$465 (Phases 1-4) + ~$50-100/month serving

---

## TIER 0C: UX OVERHAUL (Sessions 9-10 — 2026-03-23) — ALL COMPLETE

> Source: Sessions 9-10 PRs #143-149. Full redesign of navigation and document management.

| ID | Story | Status | Detail |
|----|-------|--------|--------|
| UX-NAV-01 | Sidebar simplification | **COMPLETE** | 5 main items: Dashboard, Documents, Organization, Search, Settings |
| UX-DOC-01 | Unified Documents page | **COMPLETE** | `/documents` with tabs: All / My Records / Issued to Me / Attestations |
| UX-ORG-01 | Create Organization fix | **COMPLETE** | Dialog-based instead of broken redirect |
| UX-ORG-02 | Org pages consolidated | **COMPLETE** | OrganizationPage redirects to OrgProfilePage |
| UX-QR-01 | QR download for SECURED records | **COMPLETE** | PNG export on RecordDetailPage |
| UX-SEARCH-01 | Drag-to-verify on Search | **COMPLETE** | File drop → client-side hash → auto-search |
| UX-SEARCH-02 | Search type tabs | **COMPLETE** | Issuers / Credentials / Verify Document tabs |

---

## TIER 5E: QA AUDIT — REMAINING ITEMS (2026-03-23)

_From external QA/UAT Performance Resilience Audit (`QAAudit.docx`). 11 of 25 action items implemented in PR #162. Remaining items require infrastructure changes or new feature work._

### Completed (PR #162 — merged to main)
| ID | Fix | Status |
|----|-----|--------|
| ~~RACE-1~~ | ~~Status guard on anchor UPDATE~~ | **FIXED** |
| ~~RACE-2~~ | ~~Validate broadcast response~~ | **FIXED** |
| ~~RACE-3~~ | ~~Advisory lock on confirmation job~~ | **FIXED** |
| ~~RACE-5~~ | ~~Status guard on revocation UPDATE~~ | **FIXED** |
| ~~RACE-6~~ | ~~Webhook idempotency key fix~~ | **FIXED** |
| ~~ERR-1~~ | ~~DB circuit breaker + /health~~ | **FIXED** |
| ~~ERR-2~~ | ~~Mempool.space retry + blockstream fallback~~ | **FIXED** |
| ~~ERR-3~~ | ~~Graceful shutdown awaits in-flight ops~~ | **FIXED** |
| ~~PERF-2~~ | ~~Parallel confirmation DB updates~~ | **FIXED** |
| ~~PERF-7~~ | ~~Configurable fee ceiling (BITCOIN_MAX_FEE_RATE)~~ | **FIXED** |

### Infrastructure — Requires External Services
| ID | Description | Priority | Blocker |
|----|-------------|----------|---------|
| ~~QA-PERF-1~~ | ~~Redis-backed rate limiting (Upstash Redis)~~ | ~~HIGH~~ | **CODE COMPLETE** — `upstashRateLimit.ts` + 12 tests + wired in `index.ts`. Needs `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` env vars in Cloud Run. |
| ~~QA-PERF-3~~ | ~~PgBouncer connection pooling~~ | ~~MEDIUM~~ | **CODE COMPLETE** — `db.ts` pooler detection + `db.test.ts` (QA-PERF-3 tests). Needs `SUPABASE_POOLER_URL` env var in Cloud Run to activate. |
| ~~QA-PERF-6~~ | ~~Database query performance monitoring~~ | ~~MEDIUM~~ | **CODE COMPLETE** — `queryMonitor.ts` + 13 tests. Slow query logging (>1s warn, >5s error), `monitorQuery()` wrapper, `getQueryStats()` aggregation. Needs `pg_stat_statements` enabled in Supabase. |

### Frontend — New Feature Work
| ID | Description | Priority | Notes |
|----|-------------|----------|-------|
| ~~QA-PERF-5~~ | ~~Virtual scrolling for 500+ record lists~~ | ~~LOW~~ | **ALREADY HANDLED** — RecordsList has IntersectionObserver-based progressive virtualization (batch 50, threshold 100). OrgRegistryTable uses server-side pagination (10/page). No additional work needed. |

### E2E Coverage Gaps — 9/9 COMPLETE
| ID | Description | Priority | Status |
|----|-------------|----------|--------|
| ~~QA-E2E-01~~ | ~~Billing E2E suite (Stripe test mode)~~ | ~~HIGH~~ | **COMPLETE** — `e2e/billing.spec.ts` (16 tests: pricing tiers, checkout flow, plan badges, usage) |
| ~~QA-E2E-02~~ | ~~API key + verify + webhook E2E~~ | ~~HIGH~~ | **COMPLETE** — `e2e/api-keys.spec.ts` (15 tests) + `e2e/api-verify-flow.spec.ts` (9 tests: key CRUD, verify endpoint, health, OpenAPI) |
| ~~QA-E2E-03~~ | ~~Member invite E2E~~ | ~~MEDIUM~~ | **COMPLETE** — `e2e/member-invite.spec.ts` (8 tests: invite flow, validation, role selection, modal state) |
| ~~QA-E2E-04~~ | ~~Public search E2E~~ | ~~MEDIUM~~ | **COMPLETE** — `e2e/public-search.spec.ts` (9 tests: unauthenticated search, type tabs, verify links, perf) |
| ~~QA-E2E-05~~ | ~~Proof download E2E (PDF + JSON)~~ | ~~MEDIUM~~ | **COMPLETE** — `e2e/proof-download.spec.ts` (4 tests: PDF/JSON download, structure validation, status visibility) |
| ~~QA-E2E-06~~ | ~~Issue credential full submit E2E~~ | ~~MEDIUM~~ | **COMPLETE** — `e2e/secure-document.spec.ts` (6 tests: upload, multi-step wizard, success confirmation) |
| ~~QA-E2E-07~~ | ~~Seed SECURED anchors fixture~~ | ~~LOW~~ | **COMPLETE** — `e2e/fixtures/seed-anchors.ts` (seedAnchors/cleanupSeedAnchors, 4 anchor states) |
| ~~QA-E2E-08~~ | ~~Cross-browser E2E (Firefox + Safari)~~ | ~~LOW~~ | **COMPLETE** — playwright.config.ts: firefox, webkit, mobile-chrome, mobile-safari projects |
| ~~QA-E2E-09~~ | ~~Mobile viewport E2E (375px)~~ | ~~LOW~~ | **COMPLETE** — `e2e/mobile-viewport.spec.ts` (12 tests: auth, dashboard, nav, search, record detail, touch targets) |

### Resilience — Chaos/Fault Testing — ALL COMPLETE (2026-03-29)
| ID | Description | Priority | Status |
|----|-------------|----------|--------|
| ~~QA-CHAOS-01~~ | ~~Supabase outage simulation test~~ | ~~MEDIUM~~ | **COMPLETE** — `chaos-db-outage.test.ts` (14 tests: circuit breaker state machine, timeout wrapper, sustained outage) |
| ~~QA-CHAOS-02~~ | ~~Mempool.space unavailability test~~ | ~~MEDIUM~~ | **COMPLETE** — `chaos-mempool-unavail.test.ts` (29 tests: retry classification, backoff, 5xx/network/timeout, duplicate TX detection) |
| ~~QA-CHAOS-03~~ | ~~Stripe webhook duplicate delivery test~~ | ~~LOW~~ | **COMPLETE** — `chaos-webhook-idempotency.test.ts` (7 tests: duplicate key caching, rapid-fire simulation, scope isolation) |
| ~~QA-CHAOS-04~~ | ~~Embedding memory pressure test~~ | ~~LOW~~ | **COMPLETE** — `chaos-embedding-pressure.test.ts` (11 tests: edge cases, PII exclusion, bounded stores, batch load) |

---

## TIER 0E: PHASE 2 — AGENTIC LAYER (Planned, 2026-04-03)

> Source: Phase II Gap Analysis, Arkova-Master-Strategy-Complete
> Story doc: [22_phase2_agentic_layer.md](./stories/22_phase2_agentic_layer.md)

**Phase II — Agentic Layer: Make Arkova verification a first-class primitive for autonomous AI agents.**

| ID | Story | Priority | Status | Sprint | Depends On | Effort |
|----|-------|----------|--------|--------|------------|--------|
| PH2-AGENT-01 | Verification audit trail (log /api/v1/verify calls to audit_events) | P0 | NOT STARTED | S1 | — | Small |
| PH2-AGENT-02 | Attestation Bitcoin anchoring (wire attestations to anchor pipeline) | P0 | NOT STARTED | S1 | — | Medium |
| PH2-AGENT-03 | Webhook event triggers (anchor SECURED/REVOKED, attestation events) | P1 | NOT STARTED | S2 | PH2-AGENT-02 | Medium |
| PH2-AGENT-04 | Record authenticity oracle (POST /api/v1/oracle/verify, signed responses) | P1 | NOT STARTED | S2 | PH2-AGENT-01 | Large |
| PH2-AGENT-05 | Agent identity & delegation (registration, scoped API keys, delegation chains) | P2 | NOT STARTED | S3 | PH2-AGENT-04 | XL |
| PH2-AGENT-06 | Agent framework integrations (LangChain, AutoGen, MCP enhancements) | P2 | NOT STARTED | S3 | PH2-AGENT-04, PH2-AGENT-05 | Large |

**Phase III — AdES Signature Engine & eIDAS Compliance (Jira Epic: SCRUM-421):**

| ID | Story | Priority | Status | Jira | Depends On | Effort |
|----|-------|----------|--------|------|------------|--------|
| PH3-ESIG-01 | AdES signature engine (XAdES, PAdES, CAdES — ETSI EN 319 132/142/122) | P0 (Phase III) | **IN PROGRESS** | SCRUM-422 | Phase II complete | XL |
| PH3-ESIG-02 | QTSP integration (RFC 3161 timestamp tokens, ETSI EN 319 421/422) | P1 (Phase III) | **IN PROGRESS** | SCRUM-423 | PH3-ESIG-01 | XL |
| PH3-ESIG-03 | Compliance center (audit proofs, policy transparency, SOC 2 bundles) | P1 (Phase III) | NOT STARTED | SCRUM-424 | PH3-ESIG-01, CML-03 | Large |

**Phase III Progress:**
- DB migrations: 0163 (signing_certificates), 0164 (signatures), 0165 (timestamp_tokens) — schema complete
- AdES engine: `services/worker/src/signatures/` — types, constants, PKI module, RFC 3161 client, QTSP provider with circuit breaker, LTV builder/validator, orchestrator
- API endpoints: POST /sign, GET /signatures/:id, POST /verify-signature, GET /signatures, POST /signatures/:id/revoke
- Tests: 43 passing (hsmBridge, qtspProvider, ltvBuilder, adesEngine)
- Architecture spec: `docs/stories/23_phase3_esignatures.md`

**Compliance & Audit Readiness (Jira Epic: SCRUM-426):**

| ID | Story | Priority | Status | Jira | Depends On | Effort |
|----|-------|----------|--------|------|------------|--------|
| COMP-01 | Evidence model explainer on verification pages | P0 | **COMPLETE** | SCRUM-427 | None | Medium |
| COMP-02 | Credential provenance timeline | P1 | **COMPLETE** | SCRUM-428 | None | Large |
| COMP-03 | Independent verification guide (verify without Arkova) | P0 | **COMPLETE** | SCRUM-429 | None | Medium |
| COMP-04 | Data retention policy page (GDPR Art. 13/14) | P1 | **COMPLETE** | SCRUM-430 | None | Small |
| COMP-05 | Key ceremony documentation & audit evidence | P1 | **COMPLETE** | SCRUM-431 | None | Medium |
| COMP-06 | Batch verification & audit sampling (ISA 530) | P0 | **COMPLETE** | SCRUM-432 | None | Large |
| COMP-07 | Compliance trend dashboard | P1 | **COMPLETE** | SCRUM-433 | COMP-06 | Medium |
| COMP-08 | Compliance event webhooks (GRC platform integration) | P2 | **COMPLETE** | SCRUM-434 | COMP-07 | Medium |

**Story doc:** `docs/stories/24_compliance_audit_readiness.md`

**Strategic value:** Eliminates audit friction for SOC 2 Type II, eIDAS supervision, and enterprise procurement. Transforms Arkova from "trust us" to "verify us" — the independent verification guide alone is a competitive differentiator no signing platform offers.

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
