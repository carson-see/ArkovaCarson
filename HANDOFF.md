# HANDOFF.md — Arkova Phase 3/4 Living State

> **Initialized:** 2026-03-14
> **Purpose:** Track exact project state through Phase 3 (Go-Live) and Phase 4 (Verification API). Replaces MEMORY.md as the active state file. Historical context preserved in `ARCHIVE_memory.md`.
> **Update frequency:** After every significant session or decision.

---

## Current State

### Active Phase: Phase 3 — Go-Live (Production Launch) + P8 AI Intelligence (infrastructure done)

**Goal:** Production launch of Phase 1 credentialing MVP + AI infrastructure foundation
**Methodology:** TDD (Red-Green-Refactor) + Architecture-first (sequential-thinking) + Security self-review + Playwright UI verification
**Overall progress:** 180/200 stories complete (~90%) incl. 13 Beta stories + 6 AI infra stories + 7 UX overhaul stories. **2,825 tests** (1,101 frontend + 1,724 worker, all green). 153 migration files (0001-0152, gaps at 0033+0078, 0068 split, 0088 split). P4.5 COMPLETE (13/13). P8: 19/19 (100%). Phase 1.5: 15/16 COMPLETE. AI infra: 6/6 COMPLETE (eval F1=82.1%, golden dataset 1,330 entries, 130 few-shot examples). GEO: 6 complete, 1 partial, 5 not started. **All 24/24 audit findings resolved.** Bitcoin network: **MAINNET** (116 TXs, 166K+ SECURED). Treasury funded. Frontend on arkova-26.vercel.app (also app.arkova.ai). **Pipeline LIVE:** 320K+ public records, 195K+ anchors (166K SECURED, 28K SUBMITTED on mainnet). 12 Cloud Scheduler jobs. MCP server live at edge.arkova.ai. Worker on GCP Cloud Run (1GB, max 3). **All migrations through 0152 applied to production.**

### Open Blockers

| ID | Issue | Severity | Status | Next Action |
|----|-------|----------|--------|-------------|
| ~~CRIT-2~~ | ~~Bitcoin chain client~~ | ~~**OPS-ONLY**~~ | ~~CODE COMPLETE~~ | ~~AWS KMS key provisioning, mainnet treasury funding.~~ |

**No active code blockers.** All remaining items are operational (infrastructure provisioning).

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
