# Arkova Story Documentation Index
_Last updated: 2026-03-12 ~11:30 AM EST_

## Overview

This directory contains architecture documentation for every story in the Arkova backlog. Stories are grouped by priority level, with one document per group. Each story includes: what it delivers, implementation files, database changes, security considerations, test coverage, acceptance criteria, known issues, and manual verification steps.

## Reading Order

For a new developer joining the project, read in this order:

1. **This index** — understand the story map and overall progress
2. **[CLAUDE.md](../../CLAUDE.md)** — engineering rules, Constitution, current sprint
3. **[01_architecture_overview.md](../confluence/01_architecture_overview.md)** — system architecture
4. **[02_data_model.md](../confluence/02_data_model.md)** — database schema
5. **Story docs below** — grouped by priority, in order

## Story Map

### Completion Summary

| Priority | Group | Stories | Complete | Partial | Not Started | Doc |
|----------|-------|---------|----------|---------|-------------|-----|
| P1 | Bedrock | 6 | 6 | 0 | 0 | [01_p1_bedrock.md](./01_p1_bedrock.md) |
| P2 | Identity & Access | 5 | 5 | 0 | 0 | [02_p2_identity.md](./02_p2_identity.md) |
| P3 | Vault & Dashboard | 3 | 3 | 0 | 0 | [03_p3_vault.md](./03_p3_vault.md) |
| P4-E1 | Anchor Engine | 3 | 3 | 0 | 0 | [04_p4e1_anchor_engine.md](./04_p4e1_anchor_engine.md) |
| P4-E2 | Credential Metadata | 3 | 3 | 0 | 0 | [05_p4e2_credential_metadata.md](./05_p4e2_credential_metadata.md) |
| P5 | Org Admin | 6 | 6 | 0 | 0 | [06_p5_org_admin.md](./06_p5_org_admin.md) |
| P6 | Verification | 6 | 5 | 1 | 0 | [07_p6_verification.md](./07_p6_verification.md) |
| P7 | Go-Live | 13 | 9 | 2 | 2 | [08_p7_go_live.md](./08_p7_go_live.md) |
| P4.5 | Verification API | 13 | 0 | 0 | 13 | [09_p45_verification_api.md](./09_p45_verification_api.md) |
| DH | Deferred Hardening | 12 | 0 | 0 | 12 | [10_deferred_hardening.md](./10_deferred_hardening.md) |
| MVP | Launch Gaps | 27 | 0 | 0 | 27 | [11_mvp_launch_gaps.md](./11_mvp_launch_gaps.md) |
| P8 | AI Intelligence | 19 | 0 | 0 | 19 | [12_p8_ai_intelligence.md](./12_p8_ai_intelligence.md) |
| INFRA | Infrastructure & Edge | 8 | 0 | 0 | 8 | [13_infrastructure_edge.md](./13_infrastructure_edge.md) |
| **Total** | | **124** | **41** | **3** | **80** | |

### All Stories by ID

| Story ID | Title | Status | Group Doc | Bug |
|----------|-------|--------|-----------|-----|
| P1-TS-01 | Core Enums | COMPLETE | [P1](./01_p1_bedrock.md) | — |
| P1-TS-02 | Core Tables (orgs, profiles, anchors) | COMPLETE | [P1](./01_p1_bedrock.md) | — |
| P1-TS-03 | Audit Events (append-only) | COMPLETE | [P1](./01_p1_bedrock.md) | — |
| P1-TS-04 | RLS Policies (all tables) | COMPLETE | [P1](./01_p1_bedrock.md) | — |
| P1-TS-05 | Zod Validators | COMPLETE | [P1](./01_p1_bedrock.md) | — |
| P1-TS-06 | Validation-on-Insert Wiring | COMPLETE | [P1](./01_p1_bedrock.md) | — |
| P2-TS-03 | React Router + Named Routes | COMPLETE | [P2](./02_p2_identity.md) | ~~CRIT-4~~ FIXED |
| P2-TS-04 | AuthGuard + RouteGuard | COMPLETE | [P2](./02_p2_identity.md) | ~~CRIT-4~~ FIXED |
| P2-TS-05 | useProfile Hook + DB Persistence | COMPLETE | [P2](./02_p2_identity.md) | — |
| P2-TS-06 | useOrganization Hook + OrgSettingsPage | COMPLETE | [P2](./02_p2_identity.md) | — |
| P2-TS-0X | Auth Forms + Onboarding Components | COMPLETE | [P2](./02_p2_identity.md) | ~~CRIT-4~~ FIXED |
| P3-TS-01 | Dashboard + VaultDashboard (real queries) | COMPLETE | [P3](./03_p3_vault.md) | — |
| P3-TS-02 | Privacy Toggle (is_public_profile) | COMPLETE | [P3](./03_p3_vault.md) | — |
| P3-TS-03 | Sidebar Navigation | COMPLETE | [P3](./03_p3_vault.md) | — |
| P4-TS-01 | ConfirmAnchorModal (upload + insert) | COMPLETE | [P4-E1](./04_p4e1_anchor_engine.md) | ~~CRIT-1~~ FIXED |
| P4-TS-02 | AssetDetailView (record display) | COMPLETE | [P4-E1](./04_p4e1_anchor_engine.md) | — |
| P4-TS-03 | RecordDetailPage (/records/:id) | COMPLETE | [P4-E1](./04_p4e1_anchor_engine.md) | — |
| P4-TS-04 | credential_type Enum + Column | COMPLETE | [P4-E2](./05_p4e2_credential_metadata.md) | — |
| P4-TS-05 | metadata JSONB + Editability Trigger | COMPLETE | [P4-E2](./05_p4e2_credential_metadata.md) | — |
| P4-TS-06 | parent_anchor_id + version_number Lineage | COMPLETE | [P4-E2](./05_p4e2_credential_metadata.md) | — |
| P5-TS-01 | OrgRegistryTable (filter, search, export) | COMPLETE | [P5](./06_p5_org_admin.md) | — |
| P5-TS-02 | RevokeDialog (reason + DB persist) | COMPLETE | [P5](./06_p5_org_admin.md) | — |
| P5-TS-03 | MembersTable (real Supabase query) | COMPLETE | [P5](./06_p5_org_admin.md) | — |
| P5-TS-05 | public_id Auto-Generation | COMPLETE | [P5](./06_p5_org_admin.md) | — |
| P5-TS-06 | BulkUploadWizard (credential_type + metadata) | COMPLETE | [P5](./06_p5_org_admin.md) | ~~CRIT-6~~ FIXED |
| P5-TS-07 | credential_templates CRUD + Manager UI | COMPLETE | [P5](./06_p5_org_admin.md) | — |
| P6-TS-01 | get_public_anchor RPC + PublicVerification | COMPLETE | [P6](./07_p6_verification.md) | — |
| P6-TS-02 | QR Code in AssetDetailView | COMPLETE | [P6](./07_p6_verification.md) | — |
| P6-TS-03 | Embeddable VerificationWidget | PARTIAL | [P6](./07_p6_verification.md) | — |
| P6-TS-04 | Credential Lifecycle on Public Page | COMPLETE | [P6](./07_p6_verification.md) | — |
| P6-TS-05 | PDF Audit Report (jsPDF) | COMPLETE | [P6](./07_p6_verification.md) | — |
| P6-TS-06 | verification_events Table + RPC | COMPLETE | [P6](./07_p6_verification.md) | — |
| P7-TS-01 | Billing Schema (migration 0016) | COMPLETE | [P7](./08_p7_go_live.md) | — |
| P7-TS-02 | Stripe Checkout Flow | PARTIAL | [P7](./08_p7_go_live.md) | CRIT-3 |
| P7-TS-03 | Stripe Webhook Verification | COMPLETE | [P7](./08_p7_go_live.md) | — |
| P7-TS-05 | Bitcoin Chain Client | PARTIAL | [P7](./08_p7_go_live.md) | CRIT-2 |
| P7-TS-07 | Proof Package Download | COMPLETE | [P7](./08_p7_go_live.md) | ~~CRIT-5~~ FIXED |
| P7-TS-08 | PDF Certificate (generateAuditReport) | COMPLETE | [P7](./08_p7_go_live.md) | — |
| P7-TS-09 | Webhook Settings UI | COMPLETE | [P7](./08_p7_go_live.md) | — |
| P7-TS-10 | Webhook Delivery Engine | COMPLETE | [P7](./08_p7_go_live.md) | — |
| P7-TS-11 | Signet Treasury Wallet Setup | COMPLETE | [P7](./08_p7_go_live.md) | — |
| P7-TS-12 | UTXO Provider Pattern + Mempool.space | COMPLETE | [P7](./08_p7_go_live.md) | — |
| P7-TS-13 | Fingerprint Indexing for Verification | COMPLETE | [P7](./08_p7_go_live.md) | — |
| P4.5-TS-01 | GET /api/v1/verify/:publicId | NOT STARTED | [P4.5](./09_p45_verification_api.md) | — |
| P4.5-TS-02 | POST /api/v1/verify/batch | NOT STARTED | [P4.5](./09_p45_verification_api.md) | — |
| P4.5-TS-03 | API Keys Table + HMAC + Rate Limiting | NOT STARTED | [P4.5](./09_p45_verification_api.md) | — |
| P4.5-TS-04 | OpenAPI Docs (/api/docs) | NOT STARTED | [P4.5](./09_p45_verification_api.md) | — |
| P4.5-TS-05 | Free Tier Enforcement (10K/month) | NOT STARTED | [P4.5](./09_p45_verification_api.md) | — |
| P4.5-TS-06 | GET /api/v1/jobs/:jobId | NOT STARTED | [P4.5](./09_p45_verification_api.md) | — |
| P4.5-TS-07 | Key CRUD Endpoints | NOT STARTED | [P4.5](./09_p45_verification_api.md) | — |
| P4.5-TS-08 | GET /api/v1/usage | NOT STARTED | [P4.5](./09_p45_verification_api.md) | — |
| P4.5-TS-09 | API Key Management UI | NOT STARTED | [P4.5](./09_p45_verification_api.md) | — |
| P4.5-TS-10 | API Usage Dashboard Widget | NOT STARTED | [P4.5](./09_p45_verification_api.md) | — |
| P4.5-TS-11 | API Key Scope Display | NOT STARTED | [P4.5](./09_p45_verification_api.md) | — |
| P4.5-TS-12 | Feature Flag Middleware | NOT STARTED | [P4.5](./09_p45_verification_api.md) | — |
| P4.5-TS-13 | Rate Limit Load Tests | NOT STARTED | [P4.5](./09_p45_verification_api.md) | — |
| DH-01 | Feature Flag Kill-Switch Hot-Reload | NOT STARTED | [DH](./10_deferred_hardening.md) | — |
| DH-02 | Advisory Lock for Migration 0049 Concurrency | NOT STARTED | [DH](./10_deferred_hardening.md) | — |
| DH-03 | KMS Operational Documentation | COMPLETE | [DH](./10_deferred_hardening.md) | — |
| DH-04 | Outbound Webhook Circuit Breaker | NOT STARTED | [DH](./10_deferred_hardening.md) | — |
| DH-05 | Chain Index Lookup Cache TTL | NOT STARTED | [DH](./10_deferred_hardening.md) | — |
| DH-06 | ConfirmAnchorModal Server-Side Quota Error Handling | NOT STARTED | [DH](./10_deferred_hardening.md) | — |
| DH-07 | MempoolFeeEstimator Request Timeout | NOT STARTED | [DH](./10_deferred_hardening.md) | — |
| DH-08 | Rate Limiting for check_anchor_quota RPC | NOT STARTED | [DH](./10_deferred_hardening.md) | — |
| DH-09 | UtxoProvider Retry Logic | NOT STARTED | [DH](./10_deferred_hardening.md) | — |
| DH-10 | useEntitlements Realtime Subscription | NOT STARTED | [DH](./10_deferred_hardening.md) | — |
| DH-11 | Worker RPC Logging Structured Format | NOT STARTED | [DH](./10_deferred_hardening.md) | — |
| DH-12 | Webhook Delivery Dead Letter Queue | NOT STARTED | [DH](./10_deferred_hardening.md) | — |
| MVP-01 | Worker Production Deployment | NOT STARTED | [MVP](./11_mvp_launch_gaps.md) | — |
| MVP-02 | Toast/Notification System | NOT STARTED | [MVP](./11_mvp_launch_gaps.md) | BUG-AUDIT-01 |
| MVP-03 | Legal Pages (Privacy, Terms, Contact) | NOT STARTED | [MVP](./11_mvp_launch_gaps.md) | BUG-AUDIT-02 |
| MVP-04 | Brand Assets (Logo, Favicon, OG Tags) | NOT STARTED | [MVP](./11_mvp_launch_gaps.md) | BUG-AUDIT-03 |
| MVP-05 | Error Boundary + 404 Page | NOT STARTED | [MVP](./11_mvp_launch_gaps.md) | — |
| MVP-06 | File-Based Public Verification | NOT STARTED | [MVP](./11_mvp_launch_gaps.md) | — |
| MVP-07 | Mobile Responsive Layout | NOT STARTED | [MVP](./11_mvp_launch_gaps.md) | — |
| MVP-08 | Onboarding Progress Stepper | NOT STARTED | [MVP](./11_mvp_launch_gaps.md) | — |
| MVP-09 | Records Pagination + Search | NOT STARTED | [MVP](./11_mvp_launch_gaps.md) | — |
| MVP-10 | Marketing Website (arkova.ai) | NOT STARTED | [MVP](./11_mvp_launch_gaps.md) | — |
| MVP-11 | Stripe Plan Change/Downgrade | NOT STARTED | [MVP](./11_mvp_launch_gaps.md) | CRIT-3 |
| MVP-12 | Dark Mode Toggle | NOT STARTED | [MVP](./11_mvp_launch_gaps.md) | — |
| MVP-13 | Organization Logo Upload | NOT STARTED | [MVP](./11_mvp_launch_gaps.md) | — |
| MVP-14 | Embeddable Verification Widget | NOT STARTED | [MVP](./11_mvp_launch_gaps.md) | — |
| MVP-16 | Block Explorer Deep Links | NOT STARTED | [MVP](./11_mvp_launch_gaps.md) | — |
| MVP-17 | Credential Template Metadata Enhancement | NOT STARTED | [MVP](./11_mvp_launch_gaps.md) | — |
| MVP-18 | Enhanced Metadata Display | NOT STARTED | [MVP](./11_mvp_launch_gaps.md) | — |
| ~~MVP-19~~ | ~~AI Auto-Descriptions~~ | REMOVED | [MVP](./11_mvp_launch_gaps.md) | Superseded by P8-S4/S5 |
| MVP-20 | LinkedIn Badge Integration (Phase 2) | NOT STARTED | [MVP](./11_mvp_launch_gaps.md) | — |
| MVP-21 | Individual Self-Verification Flow | NOT STARTED | [MVP](./11_mvp_launch_gaps.md) | — |
| ~~MVP-22~~ | ~~AI Fraud Detection~~ | REMOVED | [MVP](./11_mvp_launch_gaps.md) | Superseded by P8-S7/S8/S9 |
| MVP-23 | Batch Anchor Processing | NOT STARTED | [MVP](./11_mvp_launch_gaps.md) | — |
| MVP-24 | Credits Schema + Monthly Allocations | NOT STARTED | [MVP](./11_mvp_launch_gaps.md) | — |
| MVP-25 | Credits Tracking + Scheduling | NOT STARTED | [MVP](./11_mvp_launch_gaps.md) | — |
| MVP-26 | GCP Cloud Run Deployment | NOT STARTED | [MVP](./11_mvp_launch_gaps.md) | — |
| MVP-27 | GCP Secret Manager Integration | NOT STARTED | [MVP](./11_mvp_launch_gaps.md) | — |
| MVP-28 | GCP Cloud Scheduler | NOT STARTED | [MVP](./11_mvp_launch_gaps.md) | — |
| MVP-29 | GCP Cloud KMS Integration | NOT STARTED | [MVP](./11_mvp_launch_gaps.md) | — |
| MVP-30 | GCP CI/CD Pipeline | NOT STARTED | [MVP](./11_mvp_launch_gaps.md) | — |
| P8-S1 | IAIProvider Interface + Gemini Adapter | NOT STARTED | [P8](./12_p8_ai_intelligence.md) | — |
| P8-S2 | Client-Side OCR Pipeline (PDF.js + Tesseract.js) | NOT STARTED | [P8](./12_p8_ai_intelligence.md) | — |
| P8-S3 | PII Stripping Engine (Client-Side) | NOT STARTED | [P8](./12_p8_ai_intelligence.md) | — |
| P8-S4 | Metadata Field Extraction | NOT STARTED | [P8](./12_p8_ai_intelligence.md) | — |
| P8-S5 | Smart Description Generation | NOT STARTED | [P8](./12_p8_ai_intelligence.md) | — |
| P8-S6 | AI Credits Metering + Rate Limiting | NOT STARTED | [P8](./12_p8_ai_intelligence.md) | — |
| P8-S7 | Anomaly Detection Engine | NOT STARTED | [P8](./12_p8_ai_intelligence.md) | — |
| P8-S8 | Duplicate Detection (Cross-Org) | NOT STARTED | [P8](./12_p8_ai_intelligence.md) | — |
| P8-S9 | Admin Review Queue | NOT STARTED | [P8](./12_p8_ai_intelligence.md) | — |
| P8-S10 | AI Provider Hot-Swap (OpenAI/Anthropic) | NOT STARTED | [P8](./12_p8_ai_intelligence.md) | — |
| P8-S11 | Batch AI Processing Pipeline | NOT STARTED | [P8](./12_p8_ai_intelligence.md) | — |
| P8-S12 | AI Confidence Scoring + Human-in-the-Loop | NOT STARTED | [P8](./12_p8_ai_intelligence.md) | — |
| P8-S13 | AI Feature Flags + Gradual Rollout | NOT STARTED | [P8](./12_p8_ai_intelligence.md) | — |
| P8-S14 | Document Classification (Credential Types) | NOT STARTED | [P8](./12_p8_ai_intelligence.md) | — |
| P8-S15 | Expiry Date Extraction + Auto-Alerts | NOT STARTED | [P8](./12_p8_ai_intelligence.md) | — |
| P8-S16 | Multi-Language OCR Support | NOT STARTED | [P8](./12_p8_ai_intelligence.md) | — |
| P8-S17 | AI Usage Analytics Dashboard | NOT STARTED | [P8](./12_p8_ai_intelligence.md) | — |
| P8-S18 | AI Model Performance Monitoring | NOT STARTED | [P8](./12_p8_ai_intelligence.md) | — |
| P8-S19 | AI Cost Optimization + Caching | NOT STARTED | [P8](./12_p8_ai_intelligence.md) | — |
| INFRA-01 | Cloudflare Tunnel Sidecar Setup | NOT STARTED | [INFRA](./13_infrastructure_edge.md) | — |
| INFRA-02 | Wrangler + Edge Worker Scaffolding | NOT STARTED | [INFRA](./13_infrastructure_edge.md) | — |
| INFRA-03 | R2 Report Storage Bucket | NOT STARTED | [INFRA](./13_infrastructure_edge.md) | — |
| INFRA-04 | Batch Anchor Queue (Cloudflare Queues) | NOT STARTED | [INFRA](./13_infrastructure_edge.md) | — |
| INFRA-05 | Cloudflare Workers AI Fallback Provider | NOT STARTED | [INFRA](./13_infrastructure_edge.md) | — |
| INFRA-06 | Replicate QA Data Generator | NOT STARTED | [INFRA](./13_infrastructure_edge.md) | — |
| INFRA-07 | Sentry Observability Integration | NOT STARTED | [INFRA](./13_infrastructure_edge.md) | — |
| INFRA-08 | pgvector Extension + Institution Ground Truth | NOT STARTED | [INFRA](./13_infrastructure_edge.md) | — |

## Bug Cross-Reference

See [docs/bugs/bug_log.md](../bugs/bug_log.md) for full details on all bugs (including layman's summaries).

### Active Bugs

| Bug ID | Severity | Affects Stories | Summary |
|--------|----------|-----------------|---------|
| CRIT-2 | HIGH | P7-TS-05 | Bitcoin chain client CODE COMPLETE — BitcoinChainClient + provider abstractions + SupabaseChainIndexLookup + async factory + migration 0050. 408 worker tests. Remaining: operational (Signet E2E broadcast, AWS KMS provisioning, mainnet funding) |
| CRIT-3 | HIGH | P7-TS-02 | Stripe checkout PARTIAL — checkout/portal endpoints wired (b1f798a), entitlements + downgrade remaining |

### Resolved Bugs

| Bug ID | Severity | Resolution | Summary |
|--------|----------|------------|---------|
| CRIT-1 | HIGH | FIXED 2026-03-10 (a38b485) | SecureDocumentDialog fakes anchor creation |
| CRIT-4 | MEDIUM | FIXED 2026-03-10 (a38b485) | Onboarding routes render DashboardPage placeholder |
| CRIT-5 | MEDIUM | FIXED 2026-03-10 (a38b485) | JSON proof download is no-op (PDF works) |
| CRIT-6 | MEDIUM | FIXED 2026-03-10 (a38b485) | CSVUploadWizard uses simulated processing |
| CRIT-7 | LOW | FIXED 2026-03-10 | Browser tab says "Ralph" instead of "Arkova" |
| BUG-H1-01 | MEDIUM | FIXED 2026-03-10 | Silent audit event failure in processAnchor() |
| BUG-H1-02 | HIGH | REMOVED 2026-03-10 | Dead code (anchorWithClaim.ts) with nonexistent schema refs |
| BUG-H1-03 | HIGH | REMOVED 2026-03-10 | Batch loop bug in same dead code file |
| BUG-PRH1-01 | LOW | FIXED 2026-03-10 | validators.ts functions coverage below 80% threshold |
| BUG-PRH1-02 | MEDIUM | FIXED 2026-03-10 | proofPackage.ts had 0% test coverage against 80% threshold |

## Related Documentation

- [CLAUDE.md](../../CLAUDE.md) — Engineering rules, Constitution, story status (Section 8)
- [MEMORY.md](../../MEMORY.md) — Living state, blockers, sprint context
- [docs/confluence/](../confluence/) — Architecture, data model, security, audit trail
- [docs/bugs/bug_log.md](../bugs/bug_log.md) — Full bug details with reproduction steps

## Document Conventions

Each story doc follows a consistent template:

- **Group Overview** — What the priority group delivers, shared architecture context
- **Per-Story Sections** — Status, dependencies, what it delivers, files, DB changes, security, tests, acceptance criteria, known issues, manual verification
- **PARTIAL stories** include "Completion Gaps" and "Remaining Work" sections
- **NOT STARTED stories** (P4.5) include requirements summary, planned file placement, and frozen contract references

## Change Log

| Date | Change |
|------|--------|
| 2026-03-10 | Initial index created. P1 and P2 story docs written (Session 1 of 3). |
| 2026-03-10 4:15 PM EDT | Added resolved bugs (BUG-H1-01, BUG-H1-02, BUG-H1-03) to cross-reference. Split bug table into Active/Resolved sections. |
| 2026-03-10 ~7:15 PM EST | PR-HARDENING-1: Added BUG-PRH1-01 and BUG-PRH1-02 to resolved bugs (validators.ts + proofPackage.ts coverage fixes). 385 total tests. |
| 2026-03-10 ~8:00 PM EST | HARDENING-5: 7 new worker test files (96 tests). Final count: 481 total tests (228 worker + 253 frontend). All 80% thresholds pass. Worker hardening sprint COMPLETE. |
| 2026-03-10 ~9:30 PM EST | CRIT bug fix sprint: CRIT-1, CRIT-4, CRIT-5, CRIT-6 all resolved (commit a38b485). Moved from Active to Resolved bugs. P7-TS-07 promoted PARTIAL → COMPLETE. P7 totals: 5 complete, 1 partial. Overall: 35 complete, 3 partial. |
| 2026-03-11 ~12:15 AM EST | E2E testing sprint: 15 spec files (86 E2E tests), 4 load test files (25 tests), 1 performance spec (5 tests). 116 new tests total. Fixtures, CI job, and agents.md all created. |
| 2026-03-11 ~2:00 PM EST / ~4:00 AM AEDT Mar 12 | P7-TS-09 promoted PARTIAL → COMPLETE. WebhookSettings + WebhookSettingsPage tests added (34 tests). Migration 0046 for server-side secret generation. P7 totals: 6 complete, 0 partial. Overall: 36 complete, 2 partial. |
| 2026-03-11 ~3:00 PM EST / ~6:00 AM AEDT Mar 12 | P7-TS-02 promoted NOT STARTED → PARTIAL. Stripe checkout tests written: useBilling.test.ts (12), PricingPage.test.tsx (12), CheckoutSuccessPage.test.tsx (7), CheckoutCancelPage.test.tsx (5), handlers.test.ts (38). 74 new tests. Remaining: Stripe portal endpoint, entitlement enforcement, plan change/downgrade. P7 totals: 6 complete, 1 partial, 3 not started. Overall: 36 complete, 3 partial, 16 not started. |
| 2026-03-11 ~7:00 PM EST | P7-TS-05 promoted NOT STARTED → PARTIAL. SignetChainClient implemented (~300 lines) with bitcoinjs-lib OP_RETURN (ARKV prefix). Factory updated. 40 new worker tests (signet.test.ts ~15, client.test.ts 8 updated, anchor.test.ts integration). 268 worker tests total. CRIT-2 now PARTIAL. P7 totals: 6 complete, 2 partial, 2 not started. Overall: 36 complete, 4 partial, 15 not started. |
| 2026-03-11 ~8:00 PM EST | Checkout + billing portal worker endpoints wired with JWT auth (b1f798a). IDOR fix. CRIT-3 narrowed to entitlements + downgrade only. |
| 2026-03-11 ~11:00 PM EST | P6-TS-04 promoted PARTIAL → COMPLETE. AnchorLifecycleTimeline wired into PublicVerification.tsx. P6 now 5/6 complete. Overall: 37 complete, 3 partial. |
| 2026-03-11 ~11:30 PM EST | P7-TS-11 created and marked COMPLETE. Signet wallet utilities (wallet.ts, 13 tests) + CLI scripts (generate-keypair, check-balance). P7 now 7/11. Overall: 38 complete. |
| 2026-03-11 ~11:45 PM EST | P7-TS-12 created and marked COMPLETE. UTXO provider pattern (utxo-provider.ts) with RPC + Mempool.space backends. 35 tests. P7-TS-13 (fingerprint indexing) created as NOT STARTED. P7 now 8/13. Overall: 39 complete, 3 partial, 16 not started. |
| 2026-03-12 ~3:30 AM EST | CRIT-2 code complete. P7-TS-13 promoted NOT STARTED → COMPLETE (SupabaseChainIndexLookup + migration 0050). BitcoinChainClient with provider abstractions (SigningProvider, FeeEstimator, UtxoProvider). Async factory (initChainClient/getInitializedChainClient). 408 worker tests, 727 total. P7 now 9/13 complete, 2 partial, 2 not started. Overall: 40 complete, 3 partial, 15 not started (~74%). |
| 2026-03-12 ~2:00 PM EST | ADR-002 approved. 8 INFRA stories added (INFRA-01 through INFRA-08). Constitution Amendment 1.1B applied to CLAUDE.md. Total stories: 124 (was 116). Overall: 41/124 complete, 3 partial, 80 not started (~33%). |
| 2026-03-12 ~5:00 AM EST | Added Deferred Hardening group (DH-01 through DH-12). 12 stories from CodeRabbit PR #26 review, all NOT STARTED. Added 10_deferred_hardening.md. Updated completion summary to 70 total stories. |
| 2026-03-12 ~6:30 AM EST | MVP Launch Gap Audit: Added 14 MVP stories (MVP-01 through MVP-14), 3 new bugs (BUG-AUDIT-01/02/03). DH-03 promoted NOT STARTED → COMPLETE. Total: 84 stories (41 complete, 3 partial, 40 not started). |
| 2026-03-12 ~11:30 AM EST | Added P8 AI Intelligence group (19 stories, P8-S1 through P8-S19). Removed MVP-19 (superseded by P8-S4/S5) and MVP-22 (superseded by P8-S7/S8/S9). Renamed MVP-23 → Batch Anchor Processing, MVP-24 → Credits Schema + Monthly Allocations. MVP count 29→27. Total: 116 stories (41 complete, 3 partial, 72 not started). |
