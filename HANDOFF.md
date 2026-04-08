# HANDOFF.md — Arkova Phase 3/4 Living State

> **Initialized:** 2026-03-14
> **Purpose:** Track exact project state through Phase 3 (Go-Live) and Phase 4 (Verification API). Replaces MEMORY.md as the active state file. Historical context preserved in `ARCHIVE_memory.md`.
> **Update frequency:** After every significant session or decision.

---

## Current State

### Active Phase: Performance + Auth Stabilization → Phase 3 (eSignatures)

**Goal:** Enterprise-grade performance. Auth flows working. Phase 3 eSignatures next.
**Methodology:** TDD (Red-Green-Refactor) + Architecture-first (sequential-thinking) + Security self-review + Playwright UI verification
**Overall progress:** 211 stories (200 complete, ~95%). **3,898 tests** (1,476 frontend + 2,422 worker, all green). 181 migration files (0001-0180, 6 renumbered from duplicates). React Query caching layer added. P4.5 COMPLETE (13/13). P8: 19/19 (100%). Phase 1.5: 15/16 COMPLETE. AI infra: 6/6 COMPLETE (Nessie v5 87.2% F1, Gemini Golden 90.4% F1). GEO: 10/17 complete (4 transitioned to Done 2026-04-07). ATS: 8/8. CML: 5/5. **Phase II Agentic: 6/6 COMPLETE.** Phase III: 3/3 code complete (eSignatures). **COMP: 6/8 COMPLETE.** **24/24 audit findings + 9 pentest findings resolved.** Bitcoin: **MAINNET** (166K+ SECURED, 1.41M+ total). Wikidata: Q138865713. Frontend on app.arkova.ai. Worker on GCP Cloud Run. **All migrations through 0180 applied to production.** Resend domain (arkova.ai) DNS verified — email confirmations enabled. GitHub cleanup: 20 merged branches deleted, 9 worktrees removed, 8 stashes cleared.

### Open Blockers

| ID | Issue | Severity | Status | Next Action |
|----|-------|----------|--------|-------------|
| **SCRUM-502** | **Security Remediation (BIA Assessment)** | **HIGHEST** | **OPEN** | Epic: Upstash rate limiting, FileVault, incident response, SOC 2 framework. |
| **SCRUM-490** | **Attestation stuck 15+ days** | **HIGH** | **OPEN** | Anchoring pipeline not processing attestations. |
| **BUG-S33-02** | **Billing page skeleton timeout** | **MEDIUM** | **OPEN** | Worker billing endpoint times out. Investigate `/api/billing/status`. |
| **BUG-S33-03** | **Admin Overview skeleton timeout** | **MEDIUM** | **FIX READY** | Worker admin-stats.ts optimized (uses RPCs). Needs worker deploy. |

### Jira Status (2026-04-07)

37 open issues (37 To Do, 5 Blocked). 5 Jira issues transitioned to Done today (4 GEO + 1 duplicate). See Jira SCRUM board for full backlog.

### Recent Changes (2026-04-08, Session 33 — Dashboard Performance + UAT Testing)

**Critical performance fixes for 1.4M row anchors table. Comprehensive UAT click-through testing.**

| Change | Detail |
|--------|--------|
| **useAnchors perf fix** | Added explicit user_id/org_id filter to bypass full-table RLS scan. Dashboard load: 10s+ → <500ms. Query key includes org_id to prevent stale empty state. |
| **Public Issuer RPC fix** | Migration 0180: get_public_org_profile + get_public_issuer_registry exclude pipeline records. Public issuer page: infinite spinner → <1s. |
| **Admin stats optimization** | Worker admin-stats.ts: 11 queries → 3 using SECURITY DEFINER RPCs. Code ready, needs worker deploy. |
| **Search fix** | Carson's profile set to is_public_profile=true. "Arkova" issuer search now works. |
| **UAT results** | 24 pages tested. 21 PASS, 3 with issues (Billing skeleton, Admin Overview skeleton, search count includes pipeline). |
| **Migration 0180** | Applied to production. Pipeline filter on public RPCs + statement_timeout. |
| **Vercel deploys** | 3 deploys (perf fix, org_id fix, query key fix). All auto-deployed. |
| **Worker deploy** | Build succeeded but deploy failed — missing GCP secrets (openstates-api-key, bitcoin-rpc-url). Active revision: 00234-gxl. |

### Recent Changes (2026-04-07, Session 31 — Record Details + RLS Performance + Description Backfill)

**Record detail improvements. Permanent RLS performance fix for 1.4M+ records. Description backfill for pipeline anchors.**

| Change | Detail |
|--------|--------|
| **Record descriptions** | Pipeline anchors now display abstracts/descriptions. Backfill migration 0168 + trigger update (NULL→value allowed). ~63K+ OpenAlex records backfilled so far. |
| **Arkova logo** | Shield icon replaced with ArkovaLogo in Verification Certificate header. |
| **Inline filename edit** | Pencil icon on hover, inline edit with Enter/Escape. Directly updates via Supabase. |
| **RLS performance (0169)** | `is_current_user_platform_admin()` SECURITY DEFINER helper — cached per statement via STABLE. Fixes all admin dashboard timeouts on 1.4M+ records. |
| **useAnchors filter** | Pipeline_source filter pushed from client-side to Supabase query. Prevents scanning 1.4M rows. |
| **Anchor scheduling** | `scheduled.ts` now runs anchor processing in production (was non-production only). Batch processing added on interval. |
| **publicRecordAnchor** | New pipeline anchors now populate `description` from metadata (abstract/description/summary). |
| **PRs merged** | #323 (UAT bugs), #329 (RLS perf + description backfill). Both merged to main. |
| **Branch cleanup** | Deleted 5 stale remote branches (charming-feynman, fervent-lalande, fix/ci-green, feat/comp-remaining-and-geo, goofy-mayer). |
| **Deployed** | Frontend: Vercel (app.arkova.ai). DB: migrations 0166-0169 applied to production. Worker: needs Cloud Run redeploy for scheduling fix. |

### Recent Changes (2026-04-07, Session 30 — Performance + Auth + Cleanup)

**Enterprise performance overhaul. Auth email fix. Full GitHub/Jira/worktree cleanup.**

| Change | Detail |
|--------|--------|
| **React Query** | Added `@tanstack/react-query` — `useProfile`, `useAnchors`, `useOrganization` now cache with stale-while-revalidate. Instant page renders on navigation. |
| **Deferred Sentry** | `initSentry()` moved to `requestIdleCallback` + dynamic import. No longer blocks first paint. |
| **Build optimization** | Conditional source maps (only with SENTRY_AUTH_TOKEN). Vendor chunks for react-query + sentry. Font preloading. |
| **Email fix** | Root cause: Resend domain `arkova.ai` not verified (DKIM/SPF/MX DNS records missing in Cloudflare). Added 3 DNS records via Cloudflare API. Domain verification completed. |
| **GitHub cleanup** | 15 merged remote branches deleted. PR #325 (vite patch) merged. 8 open PRs remain (3 active work + 5 dependabot). |
| **Local cleanup** | 9 worktrees removed. 8 stale stashes dropped. |
| **Jira sync** | SCRUM-484 closed (duplicate). 4 GEO stories → Done (SCRUM-472/473/475/476). SCRUM-479 updated with Wikidata status. |
| **Lint fixes** | Unused imports in DataRetentionPage + SignatureCompliancePage. Sidebar test updated. |

### Recent Changes (2026-04-06, Session 29 — Sprint Completion: GEO, INFRA-07, NMT-05, PH1-PAY-02)

**Verification + testing sprint across 4 incomplete story areas. New tests written, docs updated.**

| Change | Detail |
|--------|--------|
| **GEO-10** | IndexNow worker integration verified + 11 new tests (`services/worker/src/integrations/indexnow.test.ts`). Submit script (`scripts/indexnow-submit.sh`) ready. Status: PARTIAL → needs INDEXNOW_KEY env var + key file on marketing site |
| **INFRA-07** | All 30 Sentry tests verified passing (21 worker + 9 frontend). Code complete. Status: needs SENTRY_AUTH_TOKEN + SENTRY_DSN in Vercel + Cloud Run env vars only |
| **NMT-05** | Upload script fixed for non-interactive/CI use (--no-cleanup flag, auto-cleanup in CI). Model card embedded in script. Status: READY TO SHIP — execute `./scripts/upload-hf-v5.sh` |
| **PH1-PAY-02** | All 8 x402 payment gate tests verified passing. Code complete. Status: needs ARKOVA_USDC_ADDRESS + X402_FACILITATOR_URL env vars |
| **Docs** | BACKLOG.md, stories index, GEO-10 story, NMT-05 story all updated with current status |

### Recent Changes (2026-04-05, Session 29 — Comprehensive UAT Click-Through)

**Full production click-through of 20+ pages. 10 bugs found (3 HIGH, 4 MEDIUM, 3 LOW). Bug report: `docs/bugs/uat_comprehensive_2026_04_05.md`.**

| Change | Detail |
|--------|--------|
| **UAT click-through** | Every sidebar page, admin page, settings sub-page, public page tested on app.arkova.ai |
| **BUG-UAT5-01 (HIGH)** | Public search broken — "Search failed" on all tabs. No Supabase RPC calls made. Silent catch in SearchPage.tsx:164 masks root cause. |
| **BUG-UAT5-02 (HIGH)** | Treasury page: "Unable to fetch balance/fee rates". Pipeline page: all zeros despite 1.4M+ records. Worker stats endpoints failing. |
| **BUG-UAT5-03 (HIGH)** | Pipeline monitoring page shows all zeros — same root cause as UAT5-02 |
| **BUG-UAT5-04 (MEDIUM)** | API Keys page shows "authentication_required" error card — worker usage endpoint 401 |
| **BUG-UAT5-05 (MEDIUM)** | Developers page: ~600px empty gap between metrics and feature cards |
| **BUG-UAT5-06 (MEDIUM)** | Verification page for revoked records ends abruptly — no network receipt/share/footer |
| **BUG-UAT5-07 (MEDIUM)** | Dashboard "12,575 records this month" vs Billing "Records secured: 0" — metrics inconsistency |
| **BUG-UAT5-08 (LOW)** | Attestation ARK-ATT-2026-94008AC0 stuck "Anchoring in Progress" since Mar 22 |
| **BUG-UAT5-09 (LOW)** | Verification page shows raw ISO 8601 date (2026-04-01T00:00:00Z) |
| **BUG-UAT5-10 (LOW)** | Organization page shows "— records" instead of "0 records" |
| **Pages passing** | Dashboard, Documents, Directory, Settings (all sub-pages), Billing, Admin Overview, System Health, Payments, Controls, Compliance, Secure Document modal, Auth guard |

### Recent Changes (2026-04-05, Session 29 — Sprint: 16 Stories + Code Review)

**16 stories completed across payments, SDKs, signatures, smoke tests, widgets. PR #278 open. Code review found and fixed 6 bugs. Jira updated.**

| Change | Detail |
|--------|--------|
| Phase III eSignatures | SCRUM-422/423/424 verified complete — AdES engine (62 tests), QTSP/RFC 3161, Compliance Center |
| Smoke Test Suite | SCRUM-43 — cron endpoint `/cron/smoke-test` + history + SystemHealthPage integration |
| SDK Standardization | SCRUM-439/440 — `arkova_` prefix on all tools, added `arkova_batch_verify` + `arkova_verify_signature` |
| Payment System | SCRUM-442/443/444 — credit packs (1K/10K/100K/1M), Stripe metered billing, three-tier router |
| Embeddable Widget | SCRUM-91 — `public/embed.js` iframe integration script |
| ZK-STARK | SCRUM-271 — snarkjs/poseidon-lite deps installed, 11 unit tests passing |
| Code Review Fixes | 6 bugs: billing_events columns, free credit guard, x402 replay, embed XSS, rate limiting, RPC shape |

### Recent Changes (2026-04-05, Session 28 — Audit Readiness Sprint COMP-02/04/05)

**3 compliance stories completed. PR #270 merged. GitHub v1.6.0 released. Jira SCRUM-428/430/431 Done.**

| Change | Detail |
|--------|--------|
| **COMP-04** | Data retention policy page at `/privacy/data-retention` — card layout, 8 categories, GDPR erasure, legal hold |
| **COMP-05** | Key ceremony template in Confluence + `GET /api/v1/signatures/key-inventory` endpoint (masked, admin-only) |
| **COMP-02** | Provenance timeline API (`GET /api/v1/verify/:publicId/provenance`) + collapsible frontend component |
| **Code Review** | 3 findings fixed: audit_events column names, copy.ts compliance, E2E specs added |
| **E2E** | `data-retention.spec.ts` (6 tests) + `provenance-timeline.spec.ts` (2 tests) |
| **Tests** | 31 new unit tests + 8 E2E specs |
| **GitHub** | PR #270 merged, v1.6.0 released |
| **Jira** | SCRUM-428, SCRUM-430, SCRUM-431 transitioned to Done |

### Recent Changes (2026-04-05, Session 27 — Phase III AdES Signature Engine)

**Phase III eSignature engine: 3 DB migrations (0163-0165), full module structure, 10 API endpoints, 58 tests passing. Jira epic SCRUM-421 + 3 stories created.**

| Change | Detail |
|--------|--------|
| **DB Migrations** | 0163 (signing_certificates), 0164 (signatures), 0165 (timestamp_tokens) — full schema with RLS + FORCE ROW LEVEL SECURITY |
| **Signature Engine** | `services/worker/src/signatures/` — types, constants, PKI module, RFC 3161, LTV, format builders, compliance exports |
| **API Endpoints** | 10 endpoints: sign, get, verify, list, revoke, audit-proof, export, soc2, gdpr-article30, eidas-report |
| **Frontend** | PublicSignatureVerifyPage + SignatureCompliancePage — routes wired in App.tsx |
| **Tests** | 58 passing across 6 test files |
| **Jira** | Epic SCRUM-421 + stories SCRUM-422/423/424 |

### Recent Changes (2026-04-04, Session 26 — Security Hardening + UAT Bug Sweep)

**CVSS 9.8 privilege escalation chain fixed. 19/19 UAT bugs resolved. 9 pentest findings + 7 code review issues addressed. All deployed to production.**

| Change | Detail |
|--------|--------|
| **Migration 0160** | 10 security fixes: drop anon org policy, drop dev_bypass_kyc, harden admin RPCs, restrict payment_ledger/stats, block ORG_ADMIN invites, tighten CSP |
| **Migration 0161** | 7 code review fixes: restore activate_user anon, fix pg_temp, replace VIEW with SECURITY DEFINER fn, drop organizations_select_authenticated, restore admin comments |
| **Email autoconfirm** | Disabled via Supabase Management API |
| **Test user cleanup** | hunttest1 banned, test@test.invalid deleted, attacker@evil.com invitation deleted |
| **CSP hardening** | Pinned to exact Cloud Run domain, removed *.run.app and *.railway.app wildcards |
| **PaymentAnalyticsPage** | payer_address PII removed, replaced with tx_hash |
| **UAT bugs** | SCRUM-348→370 all resolved (19/19). 500 errors, terminology, credits, disclaimer, about page |
| **Org query regressions** | RequestAffiliationDialog + useUserOrgs fixed to use RPCs instead of blocked direct table queries |
| **database.types.ts** | Regenerated from production (dev_bypass_kyc removed, new functions added) |
| **Branch cleanup** | 8 stale worktrees removed, 7 merged branches cleaned |
| **GitHub** | Issues #248-256 closed, PR #257/#259/#260 merged, v1.5.0 released |
| **Jira** | SCRUM-412→420 Done (security), SCRUM-359/362/370 Done (UAT) |
| **Confluence** | Release v1.5.0 page + security audit section in 03_security_rls.md |

### Recent Changes (2026-04-04, Session 24c — Nessie Intelligence v2 + Expanded Distillation)

**Nessie Intelligence v2 trained on 644 examples across 5 domains. Gemini Golden v2 eval: 98% type accuracy. Critical double-calibration bug fixed. All deployed.**

| Change | Detail |
|--------|--------|
| **Nessie Intelligence v2** | Together AI `ft-8fb075be-8f99` → `arkova-nessie-intelligence-v2-be2b9bcb`. 580 train / 64 val, 5 domains (SEC, legal, regulatory, academic, education), 2 epochs, 50 steps. Deployed to Cloud Run. |
| **Expanded distillation** | Fixed record_type filters (federal_register: notice/rule/proposed_rule, openalex: article/book-chapter). 644 examples balanced across 5 task types × 5 domains. |
| **Gemini Golden v2 eval** | 98.0% credentialType accuracy (49/50). Fixed eval script to include system instruction. |
| **Double calibration fix** | PROVIDER_OFFSETS.nessie: -0.15 → 0.00. calibrateNessieConfidence() already corrects overconfidence. |
| **Intelligence routing** | Context queries route directly to Nessie on Together AI with 30s timeout + Gemini fallback. |
| **HuggingFace** | Created nessie-intelligence-v1 repo, uploaded model cards to 4 repos, training data to HF. |
| **PR #242 merged** | Audit fixes, intelligence routing, eval. |

### Recent Changes (2026-04-04, Session 24d — Nessie v2 + DPO Pipeline + Audit Fixes)

**Both models trained and deployed. Gemini Golden v2: 98% accuracy. Critical bugs fixed. DPO pipeline built.**

| Change | Detail |
|--------|--------|
| **Nessie Intelligence v2** | Together AI `ft-8fb075be-8f99` — 580 train across 5 domains. Deployed to Cloud Run env var. |
| **Gemini Golden v2 eval** | 98.0% credentialType accuracy (49/50) with system instruction. |
| **Double calibration fix** | PROVIDER_OFFSETS.nessie: -0.15 → 0.00. |
| **DPO pipeline** | NMT-09: preference pair generator with 5 corruption strategies, 16 tests. |
| **Distillation expanded** | 644 examples across 5 domains. Fixed record_type filters. |
| **HuggingFace** | Intelligence repo + 4 model cards. Training data uploaded. |
| **PR #240 fix** | PublicFooter extracted, hardcoded strings → copy.ts, OP_RETURN removed. |
| **PRs merged** | #239, #242, #243, #245. |
| **BLOCKER** | Together AI needs dedicated endpoints for fine-tuned models. Gemini fallback works for now. |


### Recent Changes (2026-04-03, Session 24b — Phase II Agentic Layer + GEO Sprint + UAT Bug Sweep)

**Phase II 6/6 COMPLETE. 12 UAT bugs fixed. 4 GEO stories completed. Wikidata entity created. Security fixes for oracle HMAC + agents IDOR. PR #238 merged (10 commits).**

| Change | Detail |
|--------|--------|
| **PH2-AGENT-01** | Verification audit trail — every `/api/v1/verify/:publicId` call logged to audit_events |
| **PH2-AGENT-02** | Attestation Bitcoin anchoring — confirmed pre-existing (`attestationAnchor.ts`) |
| **PH2-AGENT-03** | Attestation webhook events — `attestation.created`, `attestation.active`, `attestation.revoked` |
| **PH2-AGENT-04** | Record Authenticity Oracle — `POST /api/v1/oracle/verify` with HMAC signatures, batch queries |
| **PH2-AGENT-05** | Agent Identity & Delegation — migration 0158, agents table, scoped API keys, 6 CRUD endpoints |
| **PH2-AGENT-06** | Agent Framework Integrations — LangChain SDK (`sdks/langchain/`), MCP oracle + list_agents tools |
| **Security fixes** | Oracle HMAC hardcoded fallback removed (hard-fail on missing secret). Agents cross-org IDOR fixed (org-ownership check on all per-resource handlers). ORG_ADMIN enforcement on agent registration. |
| **GEO-02** | Wikidata entity Q138865713 created (SaaS, official website, USA, software industry) |
| **GEO-14** | Soft 404s — NotFoundPage title updated, already implemented |
| **GEO-16** | Traction metrics on SearchPage (1.39M+, 320K+, 21 types, 87.2% F1) |
| **GEO-17** | Internal cross-links on SearchPage + DevelopersPage |
| **12 UAT bugs** | Constitution 1.3 violations, CSP frame-ancestors, sidebar, header, search chips |
| **Jira** | 25+ issues → Done, Phase II epic SCRUM-388 COMPLETE, Phase III epic SCRUM-390 created, 9 stories |
| **Confluence** | Data Model (migrations 0157), 90-Day Priority updated |
| **GitHub** | Draft release v1.3.0-rc1 created |

### Recent Changes (2026-04-03, Session 24a — Nessie Intelligence Pivot + Gemini Golden v2)

**Pivoted Nessie from extraction (Gemini's job) to compliance intelligence (Nessie's actual job). Built intelligence training data pipeline, prompts, and Gemini Golden v2 finetune script.**

| Change | Detail |
|--------|--------|
| **CRITICAL: Nessie role clarification** | Nessie = compliance intelligence engine (analyzes docs, makes recommendations). Gemini Golden = metadata extraction. Previous training was wrong — trained Nessie as extraction model. |
| **NMT-07: Intelligence training pipeline** | `nessie-intelligence-data.ts` — 5 intelligence task types (compliance_qa, risk_analysis, document_summary, recommendation, cross_reference), seed Q&A pairs, dedup, validation. 24 tests. |
| **NMT-07: Intelligence prompts** | `prompts/intelligence.ts` — System prompts for all 5 intelligence modes with verified citation requirements. 10 tests. |
| **NMT-08: Gemini Golden v2 script** | `gemini-golden-finetune.ts` updated: +phases 10-11 (291 new entries), hardcoded confidence replaced with `computeRealisticConfidence()`. Total: 1,605 entries. |
| **TS error fix** | `ActivateAccountPage.tsx`: `deriveClaimKey` → `deriveClaimKeyHash` (function was renamed). 0 TS errors now. |
| **RAG pipeline audit** | Confirmed: pgvector, embedding pipeline, Nessie query endpoint (`/api/v1/nessie/query`) with retrieval + context modes all exist. `ENABLE_PUBLIC_RECORD_EMBEDDINGS` already `true` in production. |
| **Intelligence distillation** | 339 examples generated (306 train / 33 val) from 400 SEC + 300 legal records via Gemini teacher. 5 task types. |
| **Nessie Intelligence v1 TRAINED** | Together AI `ft-14935428-4d67` → `carson_6cec/...-arkova-nessie-intelligence-v1-4b6c5a52`. 310 examples, 2 epochs, 78 steps, LoRA rank 64. |
| **Gemini Golden v2 TRAINED** | Vertex AI job `6192779736259756032` SUCCEEDED. Model: `models/2452032975731163136@1`, Endpoint: `endpoints/6659012403474202624`. 1,665 entries, 8 epochs. |
| **gcloud auth eliminated** | Replaced `gcloud auth print-access-token` + `gcloud storage cp` with service account key (`google-auth-library` + GCS JSON API). Never expires. |

### Recent Changes (2026-04-01, Session 23 — Production UAT + RLS Perf Fix + Activate Page + Bulk Upload)

**Production UAT completed for Tasks 4-5 + Bulk Upload. Critical RLS performance fix applied to 1.4M row anchors table. Three PRs merged (#235, #236, #237).**

| Change | Detail |
|--------|--------|
| **PR #237 merged** | `fix/rls-timeout-and-activate`: Anchors RLS timeout fix (subquery-based policies), ActivateAccountPage route, OrgRegistryTable `count: 'estimated'` |
| **PR #236 merged** | Dependabot: `@xmldom/xmldom` 0.8.11 → 0.8.12 (security patch) |
| **PR #235 merged** | `feat/idt-v3-tasks-1-3`: EIN validation, bulk chunking (BATCH_SIZE 50→10), privacy gate (0156+0157), RecoveryPhraseModal + recoveryPhrase.ts |
| **Revocation UAT** | Credential `ARK-ACD-Z9NMCY` issued, revoked, RED REVOKED banner verified on `/verify/ARK-ACD-Z9NMCY`, audit_events ANCHOR_REVOKED confirmed |
| **ActivateAccountPage** | `/activate?token=xxx` route added (react-router-dom), RecoveryPhraseModal wired to `activate_user` RPC, deployed + verified in production |
| **Bulk Upload UAT** | 10-record graduating class CSV uploaded via BulkUploadWizard, all 10 records created with Degree type + student names as metadata |
| **RLS performance fix (production)** | `anchors_select_org`: 2 function calls → 1 EXISTS subquery. `anchors_select_platform_admin`: per-row function → scalar subquery (InitPlan). Query time: timeout → 0.6ms |
| **Production DB changes** | Migration 0024 (index + RLS policy), platform_admin policy optimized, `authenticated` timeout 8s→30s, `bulk_create_anchors` timeout set to 60s |
| **Migrations applied** | 0156 (search privacy gate), 0157 (materialized CTE perf fix), 0024 (RLS indexes + policy) — all applied to production |
| Vercel deployment | app.arkova.ai updated via GitHub auto-deploy from merged PRs |

### Recent Changes (2026-03-31, Session 22 — Nessie v5 Training + RunPod Eval + Prompt Fix)

**Nessie v5 trained, evaluated at fp16 on RunPod, and production inference updated to use condensed prompt.**

| Change | Detail |
|--------|--------|
| Phase 10 golden dataset | +125 targeted gap-closure entries (RESUME, CLE, PATENT, MILITARY, fraud, jurisdiction, accreditation, PUBLICATION). Total: 1,605 entries across 10 phases. |
| v5 training data export | `nessie-v5-export.ts` — 1,903 train + 211 val examples, condensed 1.5K-char system prompt, 25% general data mix |
| v5 fine-tune job | Together AI `ft-b8594db6-80f9` → `carson_6cec/Meta-Llama-3.1-8B-Instruct-Reference-arkova-nessie-v5-87e1d401` |
| v4 fp16 eval | RunPod A6000 48GB: Weighted F1=65.6%, Macro F1=52.2%. Finding: fp16 ≈ 4-bit (no quality difference). |
| **v5 fp16 eval** | **Weighted F1=87.2%, Macro F1=75.7%, Conf r=0.539, ECE=11.0%, Latency=1.5s** — +21.6pp over v4 |
| Prompt template fix | Fine-tuned Nessie now uses condensed 1.5K-char prompt at inference (was 58K full prompt = 0% F1 due to mismatch) |
| Default model updated | `DEFAULT_NESSIE_MODEL` → v5 (`arkova-nessie-v5-87e1d401`) |
| v5 vs Gemini Golden | Only 3.2pp gap on weighted F1 (87.2% vs 90.4%), but v5 is 3.5x faster at zero cost |
| v5 confidence calibration | r=0.539 EXCEEDS Gemini Golden (0.426) — better calibrated |

### Recent Changes (2026-03-31, Session 21 — UAT Systematic Sweep + Record Display Fixes)

**Comprehensive UAT sweep resolving 20 frontend bugs + 3 backend migrations + AI training pipeline.**

| Change | Detail |
|--------|--------|
| UAT sweep | Systematic review of all user-facing pages at desktop + mobile. 20 frontend bugs resolved, 6 triaged as non-code-fixable. |
| Migration 0148 | Fix `lookup_org_by_email_domain` and `join_org_by_domain` RPCs referencing non-existent `deleted_at` column |
| Migration 0149 | Fix attestations_select RLS recursion with `get_user_org_id()` SECURITY DEFINER helper |
| Migration 0150 | Add trigram GIN indexes on `anchors.filename`/`description`, btree on `credential_type`, partial index for search |
| Migration 0151 | ARK-prefixed public_id format (`ARK-{CATEGORY}-{6_ALPHANUM}`) for new anchors |
| Migration 0147 | ZK-STARK evidence columns on `extraction_manifests` (tracked + applied) |
| Migration 0152 | Platform admin RLS bypass, optimized `search_public_credentials`, attestations EXISTS fix |
| Migrations applied | All migrations 0001-0152 now applied to production Supabase |
| Shared utilities | `formatCredentialType()` in copy.ts, `getNetworkDisplayName()` in platform.ts |
| Terminology compliance | Constitution 1.3 fixes across SearchPage, AnchorStats, SystemHealthPage |
| Credit widget | Shows "Unlimited / Beta" per no-limits-during-beta policy |
| Record display | EDGAR source URLs, description display, email exposure fix, ARK-prefixed IDs |
| NMT-03 merged | Nessie confidence recalibration |
| NMT-06 merged | Nessie v4 training data pipeline |
| PRs merged | #225, #226, #228, #229 — all CI green, squash-merged to main |
| Branches cleaned | All 4 feature branches deleted from remote + local |

### Recent Changes (2026-03-30, Session 20 — Nessie v4 Training Pipeline + Best Practices Audit)

**Built Nessie v4 training data pipeline based on comprehensive best-practices audit.**

| Change | Detail |
|--------|--------|
| Best practices audit | Cross-referenced "Nessie-Training-Best-Practices" document against codebase. Identified 10 gaps: LR 40x too low, circular training data, no general mix, no dedup, hardcoded confidence, no base model baseline, no prompt template verification. |
| v4 data module | `src/ai/training/nessie-v4-data.ts` — realistic confidence scoring, deduplication, validation (rejects 0.92 hardcode), general data mixing, LoRA-correct hyperparameters. 50 tests. |
| v4 pipeline script | `scripts/nessie-v4-pipeline.ts` — Gemini Golden distillation, ground truth validation, domain-specific system prompts (SEC/Legal/Regulatory/Academic), JSONL export, Together AI training submission. |
| Domain system prompts | SEC specialist (filing types, CIK, EDGAR), Legal specialist (court hierarchy, citations, precedent), Regulatory specialist (CFR structure, rulemaking), Academic specialist (DOI, accreditation, retractions). |
| NMT-03 complete | Nessie confidence recalibration: piecewise linear calibration layer, 8 empirical knots, provider offset fix. PR #225. |
| NMT-04 blocked | RunPod GPU provisioning platform-wide outage: 5 GPU types, secure+community cloud, 3 Docker images, 2 serverless endpoints — all failed. Queued jobs purged. |
| Gemini Golden deployed | Vertex AI fine-tuned model live in Cloud Run. 90.4% F1 vs 82.1% baseline. |
| Pipeline running | Distilling 500 examples/domain × 4 domains from Gemini Golden with validation. |

### Recent Changes (2026-03-30, Session 19 — Nessie Model Comparison Eval)

**Three fine-tuned Nessie models evaluated on local Apple Silicon (MLX 4-bit quantized).**

| Change | Detail |
|--------|--------|
| Local eval infrastructure | MLX-based inference on M4 Mac (4-bit quantized Llama 3.1 8B). Download merged models from Together AI → quantize → serve via mlx_lm.server. Eval script at `services/worker/scripts/eval-model-comparison.ts`. |
| Minimal extraction prompt | Created 600-token prompt (field defs only) vs production 25K-token prompt. Fine-tuned models don't need few-shot examples for basic extraction. |
| v3 baseline eval | Macro F1: 56.4%, Weighted F1: 58.4%. Best types: PROFESSIONAL (85.6%), LEGAL (83.3%), INSURANCE (72.2%), DEGREE (70.8%). |
| Reasoning v1 eval | Macro F1: 34.2%, **Weighted F1: 63.3%** (best). Best types: LEGAL (100%), INSURANCE (83.3%), DEGREE (79.5%), OTHER (78.3%). Lower macro F1 due to 0% RESUME. |
| DPO v1 eval | Macro F1: 30.7%, Weighted F1: 57.8%. Best confidence calibration (r=0.337). Best types: INSURANCE (83.3%), LEGAL (83.3%), DEGREE (76.0%). |
| All models overconfident | 85-90% reported confidence vs 34-46% actual accuracy. Training data needs confidence recalibration. |
| Comparison report | Full analysis at `services/worker/docs/eval/model-comparison-2026-03-30.md` |
| HuggingFace repos created | `carsonarkova/nessie-v3-llama-3.1-8b`, `carsonarkova/nessie-reasoning-v1-llama-3.1-8b`, `carsonarkova/nessie-dpo-v1-llama-3.1-8b` (private, empty — need weight upload) |

### Recent Changes (2026-03-28, Session 18 — AI Extraction Accuracy + Golden Dataset Phase 8)

**Major AI extraction improvements targeting Bootstrap Strategy priorities.**

| Change | Detail |
|--------|--------|
| SEC_FILING issuerName fix | Extraction prompt was setting issuerName to "SEC" instead of the filing company. Fixed prompt guidance + all 6 SEC_FILING few-shot examples. Root cause of 36.8% F1 for SEC_FILING type. |
| EDGAR-specific guidance | Comprehensive guidance for 12+ SEC form types (10-K, 10-Q, 8-K, DEF 14A, S-1, 13F, 20-F, Form 4, SC 13D, Form ADV, 10-KSB, Form 144). |
| Case law guidance | Full court hierarchy added: SCOTUS, Circuit Courts, District Courts, Bankruptcy, State Supreme/Appellate, Municipal, Administrative (NLRB, FTC, SEC ALJ, Tax Court). |
| ATTESTATION guidance | 7 subtypes: employment verification, education verification, affidavits, character references, good standing, income verification, enrollment verification. |
| OCR/image handling | New prompt section for handling OCR-corrupted documents: character substitutions, broken/merged words, noise patterns. |
| 20 new few-shot examples | Examples 111-130 covering SCOTUS opinion, circuit/district court, employment verification, sworn affidavit, Form 4, SC 13D, bankruptcy court, OCR-corrupted docs, foreign filings, notarized references. Total: 130 examples. |
| Golden dataset Phase 8 | 150 new entries: 40 SEC_FILING/EDGAR, 40 LEGAL/case law, 30 ATTESTATION, 20 OCR-corrupted, 10 REGULATION, 10 PATENT. Total dataset: 1,330 entries. |
| Doc updates | CLAUDE.md, BACKLOG.md, HANDOFF.md updated with current stats (139 migrations, 2,825 tests, 166K+ SECURED anchors). |

### Recent Changes (2026-03-27, Session 17 — MAINNET MIGRATION + First Bitcoin TX)

**Mainnet migration complete. First Bitcoin mainnet transaction confirmed.**

| Change | Detail |
|--------|--------|
| Signet → Mainnet migration | All 9,015 BROADCASTING+SECURED signet anchors reset to PENDING with `mainnet_migrated` metadata flag. 68,202 total anchors now PENDING for mainnet re-anchoring. |
| First mainnet TX | TX `1abeb071...fc97eb` confirmed in block 942,403. 95 anchors batched via Merkle tree with ARKV OP_RETURN prefix. Fee: 157 sats. |
| Second mainnet TX | TX `b73e8b97...26513c` broadcast to mempool, awaiting confirmation. |
| Treasury | `bc1qtm2kk33k6ht4agt48kh7rfkmmhfkapqn4zwerc` with ~34k sats. WIF signing via BitcoinChainClient. |
| protect_anchor_status_transition fix | Added `current_user = 'postgres'` bypass for SECURITY DEFINER functions (migration 0125). |
| PostgREST stability | Increased authenticator statement_timeout 30s→60s. Installed pg_cron extension. Scheduled hourly VACUUM to prevent autovacuum from blocking PostgREST schema cache. |
| Batch size | Reduced BATCH_ANCHOR_MAX_SIZE 10000→100 in worker-deploy.yml due to PostgREST proxy timeouts on large batches with 68k dead tuples. |
| Cloud Scheduler | batch-anchors (*/5) and check-confirmations (*/2) resumed. Other pipeline jobs paused. |

### Recent Changes (2026-03-24, Session 16 — Production Stability + Migration Sync)

**Critical production fixes and full migration sync.**

| Change | Detail |
|--------|--------|
| Railway worker deploy | Root `railway.json` created with build/deploy config pointing to `services/worker`. Root Directory set to `services/worker` in Railway dashboard. Env vars configured for signet anchoring + Gemini AI. |
| Org settings RLS fix | Migration 0107: `is_org_admin_of()` and `get_user_org_ids()` changed from SECURITY INVOKER to SECURITY DEFINER. Fixes circular RLS that silently blocked all org setting updates. Applied to production. |
| OrgProfilePage save fix | Removed unsafe `as Record<string, unknown>` cast. Proper typed updates with undefined filtering. |
| Full migration sync | All 18 unapplied migrations (0090-0107) applied to production via Supabase MCP. Includes: pipeline RPCs, credential type enums, quota enforcement, advisory locks, payment tables, unified credits, GIN indexes, platform admin flag, org profile columns, and more. |
| Worker test fixes | Fixed gemini.test.ts (embedding model name update) and chain-maintenance.test.ts (advisory lock now no-op). All 1,409 worker tests pass. |
| Worker lockfile | Regenerated `services/worker/package-lock.json` (was deleted, blocking `npm ci`). |
| Production DB data | Org fields populated, platform admin flags set, org RLS recursion fixed. |

### Recent Changes (2026-03-24, Session 15 — North Star Priorities: Base Chain + AI Tuning + Golden Dataset)

**All 5 North Star priorities advanced in this session.**

| Change | Detail |
|--------|--------|
| Base L2 chain client | New `BaseChainClient` implementing `ChainClient` interface via viem. Calldata-based anchoring (ARKV prefix + fingerprint). Supports Base mainnet (8453) and Base Sepolia (84532). Comprehensive tests. |
| Bitcoin mainnet readiness | Verified full code path: KMS signing (AWS + GCP), factory mainnet branch, fee estimation. Created `docs/ops/MAINNET_READINESS.md` operational runbook with step-by-step guide. |
| Golden dataset expansion | Phase 5 + Phase 6 datasets (~1,300 new entries). Coverage: all 16 credential types including BADGE, ATTESTATION, FINANCIAL, LEGAL, INSURANCE, SEC_FILING, PATENT, REGULATION, PUBLICATION. Edge cases: corrupted OCR, international docs, adversarial inputs. Target: 2,050+ total entries. |
| Gemini prompt tuning | Added 4 new guidance sections: CERTIFICATE-SPECIFIC, OTHER-TYPE, INSURANCE-SPECIFIC, LEGAL-SPECIFIC. Added 8 new few-shot examples (49-56) covering Azure cert, OSHA trade cert, attestation letter, IEEE membership, COI, NDA, patent, and journal article. |
| viem dependency | Installed in services/worker for EVM chain interaction. |

### Recent Changes (2026-03-24, Session 14 — Anchor Pipeline Fix + Org Persistence + Performance + Deploy)

**Critical fixes:** Anchor processing unblocked, org settings persistence, page performance, worker deploy pipeline

| Change | Detail |
|--------|--------|
| Advisory lock bug | `pg_try_advisory_lock` fails silently via PostgREST (connection pooling). Replaced with in-process mutex. **This was blocking ALL anchor confirmations.** |
| Switchboard flag fix | `ENABLE_PROD_NETWORK_ANCHORING` env var now authoritative in dev. seed.sql ON CONFLICT DO UPDATE. |
| Org persistence (BUG) | Migration 0105: added description, website_url, logo_url, founded_date, org_type, linkedin_url, location columns. Full settings form. Silent RLS failure detection via .select() on UPDATE. |
| Credential type expansion | Migration 0103: BADGE, ATTESTATION, FINANCIAL, LEGAL, INSURANCE enum values. Full-stack: validators.ts, CredentialRenderer, copy.ts. |
| Performance (treasury/pipeline) | Migration 0106: 6 indexes + get_pipeline_stats() and get_treasury_stats() RPCs. Replaced 7+ full-table-scan queries with single RPC calls. |
| Anchor detail view | Pipeline-style layout: ANCHOR RECORD section with 2-column grid, METADATA key-value pairs, CopyButton component, cyan linked tx hashes. |
| Worker TS errors | Fixed all 6: payment_source_id cast, advisory lock simplification, req.id cast, @upstash/redis ts-expect-error, test body cast. |
| Deploy workflow | Renamed deploy-worker.yml → worker-deploy.yml (GitHub cache issue). Removed CI job (rollup binary issue). Removed --allow-unauthenticated (IAM). Fixed missing GCP secrets. |
| Production DB sync | Migrations 0103-0106 applied to production via Supabase MCP. |
| Database types | Regenerated database.types.ts for all new columns/enums. |
| Sprint plan | docs/SPRINT_2026-03-25.md with 5-day plan covering AI tuning, GEO, infra debt, bugs. |

### DEPLOY STATUS: Worker on GCP Cloud Run (1GB, max 3 instances). Bitcoin MAINNET. All migrations applied through 0135.

---

## CARSON'S 5 NORTH STAR PRIORITIES (updated 2026-03-28)

1. ~~**Anchoring cron 24/7**~~ — **DONE.** Cloud Run worker running, 12 Cloud Scheduler jobs, 116 mainnet TXs, 166K+ SECURED.

2. **Base mainnet** — Base chain client code complete. Needs flip to Base mainnet (currently Sepolia).

3. ~~**Bitcoin mainnet**~~ — **DONE.** 116 TXs, 166K+ SECURED anchors on mainnet. GCP KMS signing operational.

4. ~~**Golden dataset expansion**~~ — **DONE.** 1,330 entries across 8 phases (was 750). All 21 credential types covered.

5. **Gemini performance** — Macro F1=78.1%, Weighted F1=86.5%. SEC_FILING (36.8%), PUBLICATION (51.4%), OTHER (53.9%) still weak. Prompt updated with 130 few-shot examples. Needs re-eval to measure improvement.

---

### Recent Changes (2026-03-23, Session 13 — Bug Fixes + Org Rebuild + Deploy)

**PRs #157-160 (4 PRs):** [object Object] fix + extraction toast + org LinkedIn rebuild + About nav

| Change | Detail |
|--------|--------|
| [object Object] fix | CredentialRenderer + MetadataDisplay: JSON.stringify objects instead of String(). Pipeline fields filtered from display. 4 regression tests. |
| Extraction toast | Silent failure now shows warning toast. AI_EXTRACTION_LABELS.EXTRACTION_FAILED_TOAST. 2 new tests. |
| Org page rebuild | LinkedIn-style: larger banner, 28x28 logo, meta row with icons, Home/People/Settings tabs with underline indicators |
| About nav | "About Arkova" added to header user dropdown (Info icon) |
| Worker deploy | Rev00064: env vars restored (were stripped). Rev00063 image + YAML env file. /health confirmed healthy. |
| Lint cleanup | Removed unused BarChart3, mempoolAddressUrl, CardDescription, Separator imports |
| Docs sync | CLAUDE.md, BACKLOG.md, HANDOFF.md updated with AI infra stories, corrected counts (180/192 = 94%) |
| Test total | 984 frontend tests, all green. 0 lint errors. |

### Recent Changes (2026-03-23, Session 12 — AI Infrastructure + Anchoring Throughput)

**PRs #4-10 (7 PRs):** AI eval framework + confidence calibration + anchoring 110x throughput + org fixes

| Change | Detail |
|--------|--------|
| AI-EVAL-01 | Golden dataset (210 entries), scoring engine (F1/precision/recall per field), eval runner, 42 tests |
| AI-EVAL-02 | Live Gemini eval: F1=82.1%, confidence r=0.426 (needs recalibration), ECE=13.5%. Best: CLE 94.3%, Worst: LICENSE 59.4% |
| AI-PROMPT-01 | Prompt version hash stored with every extraction event (migration 0092) |
| AI-PROMPT-02 | Few-shot examples 11→25, targeting LICENSE and TRANSCRIPT weaknesses |
| AI-FRAUD-01 | Fraud audit CLI framework (0 flagged items in prod — integrity scoring not yet active) |
| AI-OBS-01 | Admin dashboard at /admin/ai-metrics with usage, feedback, provider, and eval baseline |
| Anchoring throughput | Confirm job: 10 individual checks → 50 tx groups (110x: ~1,100 confirms/run). Merkle batch 500→2,000 |
| Pipeline credential types | Migration 0091: SEC_FILING, PATENT, REGULATION, PUBLICATION enum values |
| Org page fix | Records count query instead of hardcoded "—" |
| ExtractedFieldsSchema | CLE fields + fraudSignals added (was silently rejecting Gemini responses) |
| Pipeline metadata display | Arrays formatted (join with commas), nulls hidden |
| Test total | 2,148 tests (979 frontend + 1,120 worker), all green |

### Recent Changes (2026-03-23, Session 11)

**PRs #150-154 (5 sprints):** GEO fixes + embedding acceleration + test stabilization + SOC 2

| Change | Detail |
|--------|--------|
| GEO infrastructure | robots.txt: 4 new AI crawlers; llms.txt: standard format with live MCP; OG image: SVG→PNG; Schema: address, jobTitle, sameAs, ORCID |
| Embedding acceleration | EMBED_BATCH_SIZE 100→500, EMBED_CONCURRENCY=10 (bounded-concurrency Promise.all) |
| Worker test stabilization | 11 flaky tests fixed: mock fetch for embeddings, beta credit bypass, anchors table mock, sequential RPC mocking |
| Branch protection | Main branch: required CI checks, no force push, no deletions. SOC 2 CC6.1 evidence |
| Test total | 2,098 tests (978 frontend + 1,120 worker), all green |

### Recent Changes (2026-03-23, Session 10)

**PRs #145-149 (5 sprints):** UX overhaul + QR/verify + AI hardening + SOC 2

| Change | Detail |
|--------|--------|
| Sidebar simplified | 5 main items: Dashboard, Documents, Organization, Search, Settings. Billing/Help/Developers in user dropdown. Admin collapsible. |
| Unified Documents page | `/documents` with tabs: All / My Records / Issued to Me / Attestations |
| Create Organization fixed | Dialog-based instead of broken redirect to onboarding |
| Org pages consolidated | OrganizationPage redirects to OrgProfilePage |
| Badge forwardRef | Fixed console ref warning |
| QR download | PNG export on RecordDetailPage for SECURED records |
| Drag-to-verify | SearchPage file drop → client-side hash → auto-search |
| Search type tabs | Issuers / Credentials / Verify Document tabs |
| CLE extraction enhanced | creditHours, creditType, barNumber, activityNumber, providerName, approvedBy |
| Fraud signal detection | AI flags: DUPLICATE_FINGERPRINT, EXPIRED_ISSUER, SUSPICIOUS_DATES, etc. |
| SOC 2 evidence doc | `docs/compliance/soc2-evidence.md` |
| TLA-02 confirmed | tla-verify CI job already existed |
| Production metrics | 22,333 records, 9,700 embeddings, 1,413 SECURED anchors, 12 scheduler jobs |

### Recent Changes (2026-03-23, Session 9)

**PRs #143-144 merged:** DAPIP API fix + UX overhaul + pipeline fixes + TLA-01

| Change | Detail |
|--------|--------|
| DAPIP fetcher fix | API URL migrated to surveys.ope.ed.gov, resumable batching for Cloud Run timeout |
| OpenAlex cursor fix | Was reading response headers (wrong), now reads meta.next_cursor |
| Dashboard simplification | Removed redundant account card + privacy toggle (moved to Settings) |
| Status labels | "Pending" → "Processing", "Secured" → "Verified" with tooltips |
| TLA-01 | credential_type immutability trigger (migration 0089) |
| Cloud Scheduler | Added fetch-dapip (every 10 min), OpenAlex increased to every 30 min |
| Worker deploy | rev00058 with DAPIP batching + OpenAlex cursor fix |
| CI/CD | deploy-worker.yml memory corrected 512Mi → 1Gi |
| Test fixes | PipelineAdminPage mock, lint errors cleaned |
| UX PRD | docs/stories/16_ux_overhaul.md |
| Branch cleanup | 17 stale branches deleted (local + remote) |

### Known UX Issues (Session 9 — user-reported)

| Issue | Severity | Detail |
|-------|----------|--------|
| Sidebar too many items | HIGH | My Records / My Credentials / Attestations should be ONE item |
| Create Organization broken | HIGH | Button redirects to dashboard instead of creating org |
| Document types confusing | HIGH | Users don't understand credential vs document vs attestation — auto-classify from metadata |

### Recent Changes (2026-03-23, Session 6)

**PR #132 merged:** `feat/session6-critical-fixes` — Critical fixes + hardening + P3/P4 polish

| Change | Files | Detail |
|--------|-------|--------|
| Public attestation verify page | `PublicAttestationVerifyPage.tsx`, `App.tsx`, `routes.ts` | `/verify/attestation/:publicId` — full verification display with status, claims, proof, revocation |
| Attestation revoke UI | `AttestationsPage.tsx` | Revoke button + confirmation dialog in detail panel |
| DevelopersPage API reference | `DevelopersPage.tsx` | Org role requirement notice + rate limits + error codes section |
| Admin user detail | `AdminUserDetailPage.tsx`, `admin-lists.ts`, `index.ts` | `/admin/users/:id` with dedicated worker endpoint |
| Dashboard attestation stat | `DashboardPage.tsx`, `StatCard.tsx` | 4th stat card with chevron affordance, onClick prop |
| Admin UX overhaul | `AdminUsersPage.tsx`, `AdminRecordsPage.tsx`, `AdminSubscriptionsPage.tsx` | shadcn Select, mobile card layout, auto-search on filter, clear filters button |
| Centralized platform constants | `platform.ts` | `isPlatformAdmin()`, treasury address, mempool URL helpers — removed from 10 files |
| Mempool links | `AssetDetailView.tsx`, `PipelineAdminPage.tsx` | Treasury fallback for PENDING/SUBMITTED records |
| Unified Secure Document | `SecureDocumentDialog.tsx`, `FileUpload.tsx` | Single catchall: auto-detects single/bulk/CSV upload |
| Anchor filter fix | `anchor.ts` | Pipeline records filtered from individual processor (Merkle batch only) |
| Org onboarding | `OrgOnboardingForm.tsx` | legal_name optional, display_name primary |
| x402 payments | switchboard_flags | `ENABLE_X402_PAYMENTS` enabled in production |
| Demo seed strip | Production DB | OPS-02: `admin@umich-demo.arkova.io` deleted |

### Recent Changes (2026-03-23, Session 5)

**PR #131:** `feat/session5-attestation-anchoring-admin-lists` — Attestation anchoring + admin master lists + EDGAR scaling

| Change | Files | Detail |
|--------|-------|--------|
| Attestation anchoring job | `attestationAnchor.ts`, `0086_*.sql`, `index.ts` | Merkle-batches PENDING attestations to Bitcoin, PENDING→ACTIVE, race condition detection, 8 tests |
| Admin master lists (SN1) | `admin-lists.ts`, `AdminUsersPage.tsx`, `AdminRecordsPage.tsx`, `AdminSubscriptionsPage.tsx` | Paginated searchable detail lists for users/records/subscriptions, click-through from Overview |
| EDGAR scaling | `edgarFetcher.ts`, `index.ts` | Submissions API with 30 S&P 500 CIKs, batch 100→200, historical backfill endpoint |
| Security hardening | `admin-lists.ts` | ilike wildcard sanitization, search length limit, type-safe filter assertions |
| Pipeline UX | `PipelineAdminPage.tsx` | Detail panel auto-scrolls into view on record click |

### Recent Changes (2026-03-22, Session 4)

**PR #130 merged:** `feat/sn3-attestation-ids-edgar-source-url` — Structured attestation IDs + EDGAR source URL display

| Change | Files | Detail |
|--------|-------|--------|
| SN3: Structured attestation IDs | `0085_org_prefix_attestation_ids.sql`, `attestations.ts`, `AttestationsPage.tsx` | Format: ARK-{org_prefix}-{type_code}-{unique_6}. Org prefix auto-generated from display_name. Type codes: VER/END/AUD/APR/WIT/COM/SUP/IDN/CUS. IND default for individual users. |
| EDGAR source_url display | `AssetDetailView.tsx` | Pipeline records show "Source Document" link to SEC EDGAR/OpenAlex/USPTO/Federal Register on record detail page |
| Collision retry | `attestations.ts` | Max 3 retries on UNIQUE_VIOLATION (23505) for public_id collision |
| Attestation tests | `attestations.test.ts` | 26 unit tests: type codes, ID format, validation, collision handling |

### Recent Changes (2026-03-22, Session 2)

**PR #128:** `feat/pipeline-records-browser-anchoring` — awaiting review/merge

| Change | Files | Detail |
|--------|-------|--------|
| Records Browser | `PipelineAdminPage.tsx`, `copy.ts` | Filterable table (source, type, anchor status, search), pagination (25/page), responsive |
| Individual anchoring | `publicRecordAnchor.ts` | Each pipeline doc → own anchor in `anchors` table, visible in Treasury with `[SEC]`/`[OA]` prefix |
| Stale chunk fix | `AIExtractionStep.tsx`, `aiExtraction.ts`, `useSemanticSearch.ts`, `useBulkAnchors.ts` | Dynamic `await import()` → static imports |
| Recipient fix | `useBulkAnchors.ts` | Added missing `orgId` to `/api/recipients` calls |
| Env var | Vercel | `VITE_CRON_SECRET` set for Pipeline Control buttons |

### What's Production-Ready

- Database layer (91 migrations, RLS on all tables, audit trail immutable, GDPR erasure RPCs)
- Auth flow (Supabase auth, Google OAuth, AuthGuard + RouteGuard)
- Org admin credential issuance + individual anchor creation
- Public verification portal (5-section display, verification event logging)
- CI/CD pipeline (typecheck, lint, test, copy-lint, build-check, E2E)
- Worker test coverage (1,010 tests across 66 files, 80%+ on all critical paths)
- Webhook delivery engine + settings UI
- Stripe webhook handlers + billing UI
- PDF + JSON proof downloads
- CSV bulk upload
- Bitcoin chain client (code complete, operational items remain)
- Sentry error tracking with PII scrubbing (frontend + worker)
- AI extraction pipeline (Gemini, OCR, PII stripping, credit tracking)
- Semantic search (pgvector embeddings, cosine similarity)
- MCP server at edge.arkova.ai
- GDPR compliance (PII erasure RPCs, audit log anonymization)
- Precision Engine design system (PRs #117-120, refined 2026-03-22)
- 16 credential templates + type-specific visual cards
- Pipeline: EDGAR + OpenAlex fetchers, embedder, Nessie RAG
- Pipeline admin page with records browser + controls

---

## Session Log

### Session: 2026-03-22 (Session 2) — Pipeline Records Browser + Individual Anchoring

**PR #128 created.** Records browser, individual anchoring, bulk upload fixes.

**Pipeline Records Browser:**
- Added to PipelineAdminPage below existing stats/controls
- Filters: source (EDGAR/USPTO/Fed Register/OpenAlex), record type (dynamic), anchor status (Anchored/Pending), text search (title/source ID)
- Pagination: 25/page with prev/next controls and page indicator
- Responsive: hides Type, Source ID, Fingerprint, Date on smaller screens
- Each row shows: source icon, title, type badge, source ID, fingerprint (truncated), status badge, ingested date, external link

**Individual anchoring rewrite:**
- `publicRecordAnchor.ts` completely rewritten
- Each public record creates its own anchor in `anchors` table (was: one batch anchor for all)
- Anchors owned by `carson@arkova.ai` (platform admin) with `[SEC]`/`[OA]`/`[USPTO]`/`[FR]` filename prefix
- Merkle batching still used for Bitcoin tx (cost efficient: 1 tx per 500 docs)
- Handles duplicate fingerprints via unique constraint detection (23505 error → look up existing)
- Status flow: PENDING → SUBMITTED (after chain tx) → SECURED (after confirmation checker)

**Bulk upload fixes:**
- Stale chunk: 4 files converted from `await import('@/lib/workerClient')` to static imports
- Recipient creation: added missing `orgId` parameter — was silently failing with 400

**Deployment:**
- Worker rev 00044 deploying to Cloud Run
- VITE_CRON_SECRET added to Vercel production env vars
- Frontend will auto-deploy from main after PR merge

### Session: 2026-03-22 (Session 1) — Pipeline Activation (Phase 1.5 Sprint 5)

**Commit e6f9664 pushed to main.** Pipeline end-to-end operational.

- Migrations 0077-0080 applied to production
- EDGAR + OpenAlex fetchers created and run
- 2,540 public records ingested (2,340 EDGAR + 200 OpenAlex)
- 100 embeddings generated (gemini-embedding-001)
- 1 Merkle batch anchored to signet
- Nessie RAG returning real SEC filing results
- Worker rev 00043 deployed
- Gemini embedding model fixed: gemini-embedding-001 via v1beta REST API
- Dockerfile fixed: native module build deps added

### Session: 2026-03-21 — Synthetic Sentinel + MCP Deploy + Credential Templates

PRs #117-120 merged. Design system migration, MCP at edge.arkova.ai, 16 credential templates, DEMO-04.

<!-- Older sessions archived to docs/archive/session-log.md -->

---

## GEO & SEO Optimization (17 stories — 5 NEW from 2026-03-29 audit)

### 2026-03-29 Audit Results
- **On-page SEO score:** 57/100 (C+) — keyword usage 4/10, images 3/10, internal links 5/10
- **Technical SEO:** Security headers excellent, soft 404s CRITICAL, caching weak
- **New stories created:** GEO-13 through GEO-17 based on verified audit findings

| Story | Priority | Description | Status |
|-------|----------|-------------|--------|
| GEO-01 | CRITICAL | SSR for marketing site | **COMPLETE** |
| GEO-02 | CRITICAL | Fix LinkedIn entity collision | PARTIAL |
| GEO-03 | CRITICAL | Publish /privacy and /terms | **COMPLETE** (verified 2026-03-29) |
| GEO-04 | HIGH | About page with team bios | **COMPLETE** (team section on homepage) |
| GEO-05 | HIGH | Enhanced schema | **COMPLETE** |
| GEO-06 | HIGH | Deploy upgraded llms.txt | **COMPLETE** |
| GEO-07 | HIGH | Fix broken og:image | **COMPLETE** |
| GEO-08 | HIGH | Content expansion — 5 pages | NOT STARTED |
| GEO-09 | MEDIUM | Community & brand presence | NOT STARTED |
| GEO-10 | MEDIUM | IndexNow for Bing/Copilot | NOT STARTED |
| GEO-11 | MEDIUM | YouTube explainers | NOT STARTED |
| GEO-12 | MEDIUM | Security headers | **COMPLETE** |
| **GEO-13** | **CRITICAL** | **On-page SEO fixes (title, H1, meta, keywords)** | **NOT STARTED** |
| **GEO-14** | **CRITICAL** | **Fix soft 404s (200 status on nonexistent URLs)** | **NOT STARTED** |
| **GEO-15** | **HIGH** | **Image alt text + product screenshots** | **NOT STARTED** |
| **GEO-16** | **HIGH** | **Traction numbers + social proof on homepage** | **NOT STARTED** |
| **GEO-17** | **HIGH** | **Internal linking + contextual cross-references** | **NOT STARTED** |

---

## Decision Log (Phase 3/4)

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-22 | Pipeline anchoring creates individual anchors per document | Each document must be visible in Treasury — batch-only is insufficient |
| 2026-03-22 | VITE_CRON_SECRET exposed to browser (admin-only page) | Pipeline controls need auth header; page is gated to platform admins |
| 2026-03-14 | IAIProvider as single abstraction for all AI providers | Vendor independence |
| 2026-03-14 | MCP server uses Streamable HTTP transport | Native Cloudflare Workers compat |

---

## Bug Tracker

| ID | Date | Summary | Severity | Status |
|----|------|---------|----------|--------|
| BUG-1.6 | 2026-03-22 | Forgot password error | MEDIUM | OPEN |
| BUG-2.3 | 2026-03-22 | Org admin onboarding error | MEDIUM | OPEN |
| BUG-5.8 | 2026-03-22 | QR code blank page | LOW | OPEN (VITE_APP_URL set) |
| BUG-2.5 | 2026-03-22 | Checklist doesn't show org admin steps | LOW | OPEN |
