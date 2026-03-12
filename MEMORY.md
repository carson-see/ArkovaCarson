# MEMORY.md — Arkova Living Project State

> **Last updated:** 2026-03-12
> **Purpose:** Living context for AI-assisted development sessions. CLAUDE.md has rules and story status. This file has decisions, blockers, sprint state, and institutional knowledge.
> **Update frequency:** After every significant session or decision. If you learn something during a task, update this file before closing out.

---

## Current Sprint State

### Active Work: Post-Audit Go-Live Sprint
**Goal:** Production launch of Phase 1 credentialing MVP
**Timeline:** 4 weeks from sprint start
**Team:** Carson (CEO/eng), Prajal (dev), Bitcoin specialist TBD

### Critical Blockers (ordered by priority)

| ID | Issue | Owner | Status |
|----|-------|-------|--------|
| ~~CRIT-1~~ | ~~`SecureDocumentDialog` fakes anchor creation~~ | ~~Prajal~~ | ~~**RESOLVED 2026-03-10.** Real Supabase insert. Commit a38b485.~~ |
| CRIT-2 | Bitcoin chain client — CODE COMPLETE | Specialist | **CODE COMPLETE.** BitcoinChainClient with provider abstractions: SigningProvider (WIF + KMS, 98%+ coverage), FeeEstimator (static + mempool), UtxoProvider (RPC + Mempool.space). SupabaseChainIndexLookup + migration 0050. Async factory. KMS operational docs (`14_kms_operations.md`). 455 worker tests across 19 files. **Remaining (operational only):** Signet E2E broadcast (manual), AWS KMS key provisioning (follow 14_kms_operations.md), mainnet treasury funding. |
| CRIT-3 | Stripe checkout — partial | Carson/Prajal | **PARTIAL.** Pricing UI + useBilling hook + checkout/portal worker endpoints wired (b1f798a). 74 tests. **Remaining:** entitlement enforcement, plan change/downgrade. |
| ~~CRIT-4~~ | ~~Onboarding routes are placeholders~~ | ~~Prajal~~ | ~~**RESOLVED 2026-03-10.** Wired RoleSelector, OrgOnboardingForm, ManualReviewGate. Commit a38b485.~~ |
| ~~CRIT-5~~ | ~~Proof export JSON download is no-op~~ | ~~Prajal~~ | ~~**RESOLVED 2026-03-10.** Wired onDownloadProofJson. Commit a38b485.~~ |
| ~~CRIT-6~~ | ~~CSVUploadWizard uses simulated processing~~ | ~~Prajal~~ | ~~**RESOLVED 2026-03-10.** Connected to csvParser + useBulkAnchors. Commit a38b485.~~ |
| ~~CRIT-7~~ | ~~Browser tab says "Ralph."~~ | ~~Anyone~~ | ~~**RESOLVED 2026-03-10.** `package.json` name → `arkova`, `index.html` title → `Arkova`.~~ |

### What's NOT Blocked

These areas are production-ready or very close:
- Database layer (49 migrations, RLS on all tables, audit trail immutable)
- Auth flow (Supabase auth, Google OAuth, AuthGuard + RouteGuard)
- Org admin credential issuance (`IssueCredentialForm` — real Supabase insert + Zod + audit log)
- Individual anchor creation (`SecureDocumentDialog` — fixed, real Supabase insert)
- Public verification portal (5-section display, `get_public_anchor` RPC, verification event logging)
- CI/CD (secret scanning, dep scanning, typecheck, lint, copy lint, tests)
- Worker test coverage (455 tests across 19 files, 80%+ on all critical paths incl. signing-provider.ts)
- Webhook delivery engine (HMAC signing, exponential backoff, retry cron)
- Webhook settings UI (two-phase dialog, server-side secret generation)
- Stripe webhook handlers (checkout.session.completed + subscription lifecycle)
- Billing UI (PricingPage, BillingOverview, checkout success/cancel pages)
- PDF + JSON proof downloads (both wired and working)
- CSV bulk upload (connected to real parser + useBulkAnchors hook)
- Onboarding flow (RoleSelector → OrgOnboardingForm → ManualReviewGate)

---

## Decision Log

Decisions that affect architecture and should never be revisited without explicit discussion.

| Date | Decision | Rationale | Impact |
|------|----------|-----------|--------|
| 2025-Q4 | Direct OP_RETURN only — no OpenTimestamps | Full control over anchor data format, no dependency on third-party attestation service, simpler proof verification | All chain integration must use bitcoinjs-lib with corporate treasury wallet |
| 2025-Q4 | Documents never leave device — Constitution Article 1 | FERPA compliance, competitive moat, user trust | `generateFingerprint` is browser-only. Server processes extracted text only (Phase 2 AI). No file upload endpoints ever. |
| 2025-Q4 | Skip SOC 2 Type I, go directly to Type II | Type I is a point-in-time snapshot with limited value. Type II demonstrates sustained controls. | Target Q4 2026. Evidence collection begins at production launch. |
| 2026-01 | Verification API record_uri uses HTTPS (ADR-001) | `https://app.arkova.io/verify/{public_id}` is universally resolvable by browsers, agents, and HTTP clients | No custom protocol handlers (`arkova://`). URI format is frozen. |
| 2026-01 | "Wallet" is banned from all UI | Users should never know Bitcoin is involved. Maps to "Fee Account" or "Billing Account". | Enforced by CI copy lint. See CLAUDE.md Section 1 for full banned term list. |
| 2026-02 | Gemini AI Integration Spec is NOT authoritative | The spec describes server-side document processing, which violates the Constitution | Do not reference it for architecture decisions. Client-side OCR (PDF.js + Tesseract.js) with server-side LLM on extracted text only. |
| 2026-02 | GTM Report March 2026 is authoritative pricing source | Supersedes Sales Playbook Jan 2026 and older docs | Use $1K/$3K/custom tiers from GTM report. |
| 2026-03 | CLAUDE.md story status is more current than the Technical Backlog PDF | Backlog audit notes for P4-E2 say "NOT STARTED" but migrations 0029-0032 are implemented | When status conflicts, trust CLAUDE.md Section 11 over the PDF backlog |
| 2026-03-10 | Worker hardening sprint before Bitcoin chain integration | Worker/chain critical path has 0% test coverage. processAnchor(), job claim flow, webhook dispatch all untested. Building on sand. | ~1 week of test writing before any bitcoinjs-lib work. CLAUDE.md Section 9 updated to reflect new ordering. |
| 2026-03-11 | SignetChainClient uses `ARKV` OP_RETURN prefix | 4-byte protocol identifier in every anchored transaction for future proof verification | All chain transactions carry `ARKV` + anchor fingerprint in OP_RETURN output |
| 2026-03-11 | Billing endpoints use JWT auth (not API keys) | Checkout and portal endpoints are user-facing, not machine-to-machine | Worker validates Supabase JWT from Authorization header, extracts user_id |

---

## Repo Orientation

### Where Things Live
```
CLAUDE.md                          ← Rules, Constitution, story status (~760 lines)
MEMORY.md                          ← This file. Living state, decisions, sprint context.
src/App.tsx                        ← React Router with AuthGuard + RouteGuard
src/components/anchor/             ← Document anchoring UI (SecureDocumentDialog — fixed, real inserts)
src/components/auth/               ← LoginForm, SignUpForm, AuthGuard, RouteGuard
src/components/billing/            ← BillingOverview, PricingCard
src/components/organization/       ← IssueCredentialForm, MembersTable, RevokeDialog
src/components/public/             ← PublicVerifyPage (public verification portal)
src/components/verification/       ← PublicVerification (5-section result display)
src/components/webhooks/           ← WebhookSettings (two-phase dialog + server-side secrets)
src/hooks/                         ← All data hooks (useAnchors, useAuth, useProfile, useBilling, etc.)
src/lib/copy.ts                    ← All UI strings (enforced by CI)
src/lib/validators.ts              ← Zod schemas for all writes
src/lib/fileHasher.ts              ← Client-side SHA-256 (Web Crypto API)
src/lib/routes.ts                  ← Named route constants
src/lib/switchboard.ts             ← Feature flags
services/worker/                   ← Express worker (anchoring jobs, Stripe webhooks, billing)
services/worker/src/chain/         ← ChainClient interface + MockChainClient + SignetChainClient
services/worker/src/stripe/        ← Stripe SDK + webhook verification + handlers
services/worker/src/webhooks/      ← Outbound webhook delivery engine (HMAC, backoff, retries)
supabase/migrations/               ← 49 migrations (0001-0050, 0033 skipped)
supabase/seed.sql                  ← Demo data (admin_demo, user_demo, beta_admin)
docs/confluence/                   ← 15 docs (00-14): architecture, data model, security, KMS ops, etc.
docs/stories/                      ← Story docs (10 group files + index)
e2e/                               ← Playwright E2E specs + fixtures
```

### Key Patterns to Follow
- **New hooks:** Follow `useAuth.ts` / `useAnchors.ts` pattern (Supabase query, loading/error state, refresh callback)
- **New components:** Go in `src/components/<domain>/` with barrel export in `index.ts`
- **New migrations:** Sequential numbering, include rollback comment, regenerate `database.types.ts`
- **Anchor creation:** Both `IssueCredentialForm.tsx` (org admin) and `SecureDocumentDialog.tsx` (individual) now use the correct pattern: validateAnchorCreate() → supabase.insert → logAuditEvent.

### Orphaned Code (built but not wired)
| File | What It Does | What's Missing |
|------|-------------|----------------|
| `src/components/embed/VerificationWidget.tsx` | Compact/full embeddable verification widget | Never imported. Needs route or standalone bundle. |

---

## People & Roles

| Person | Role | Context |
|--------|------|---------|
| Carson Seeger | Co-Founder/CEO (Michigan) | Makes architecture decisions. Terse Claude Code prompts. Refs story IDs. |
| Sarah Rushton | Co-Founder/COO (Sydney) | Operations, compliance, GTM. +15h timezone offset from Carson. |
| Prajal Sharma | Developer | Primary codebase contributor alongside Claude. |
| Dr. Yaacov Petscher | Co-Founder Advisor | Academic/credentialing domain expertise. |
| Dr. Periwinkle Doerfler | Technical Advisor | Security architecture review. |
| Alex Ruggeberg | Fractional Advisor (Sentient Solutions Group LLC) | PIIA drafted, open items on compensation exhibit. Not yet signed. |
| Chris Seeger | Sole convertible note holder to date | |

---

## Compliance Obligations

| Framework | Status | Target | Notes |
|-----------|--------|--------|-------|
| SOC 2 Type II | In progress | Q4 2026 | No Type I. Evidence collection starts at production launch. |
| FERPA | Architecture supports | Ongoing | Documents never leave device. No PII in anchor records. |
| Broker-dealer (FINRA/SEC) | Open question | Pre-signing | Alex Ruggeberg PIIA has transaction-based compensation — needs legal review. |

---

## Session Handoff Notes

> When ending a session, write what the next session needs to know here. Clear old notes when they're no longer relevant.

**Last session (2026-03-12 ~6:00 AM EST):** CRIT-2 Operational Readiness sprint. KMS signing coverage: 39 tests added in signing-provider.test.ts (98%+ coverage with v8 ignore on AWS SDK boundary). Added signing-provider.ts 80% threshold to vitest.config.ts. Created `docs/confluence/14_kms_operations.md` (key provisioning, IAM policy, rotation, DR) — unblocks DH-03. Updated 00_index.md (15 docs). 455 worker tests across 19 files (was 408/17). Signet integration tests: 8 tests constructing + signing real Bitcoin Signet transactions. E2E silent skip anti-pattern fixed.

**Current state:**
- 765 total tests (455 worker + 310 frontend) + 116 E2E/load tests
- All worker critical paths at 80%+ coverage (19 test files, 455 tests)
- signing-provider.ts coverage: 98.41% statements, 94.59% branches, 100% functions, 98.41% lines
- 206 chain-specific tests across 8 files (signet 47, signet.integration 8, utxo-provider 34, wallet 13, client 28, mock 18, anchor 27, signing-provider 39)
- KMS operational docs complete (14_kms_operations.md)
- Signet treasury address: `mx1zmGtQTghi4GWcJaV1oPwJ5TKhGfFpjs` — funded 500,636 sats
- PR #26 open on `feat/crit2-complete-provider-abstractions-chain-index`

## Mainnet Readiness Checklist

| # | Item | Status | Detail |
|---|------|--------|--------|
| 1 | Signet E2E broadcast | **PENDING** | Treasury funded. Requires manual execution: `BITCOIN_TREASURY_WIF=<wif> npx tsx scripts/broadcast-signet-test.ts`. Record txId here after success. Verify on `https://mempool.space/signet/tx/<txId>`. |
| 2 | AWS KMS key provisioning | **NOT STARTED** | Follow `docs/confluence/14_kms_operations.md` Section "Key Provisioning Steps". Create `ECC_SECG_P256K1` / `SIGN_VERIFY` key in us-east-1. Record KeyId → `KMS_KEY_ID` env var. |
| 3 | KMS IAM policy | **NOT STARTED** | Worker IAM role needs `kms:Sign` + `kms:GetPublicKey` on the specific key ARN. See 14_kms_operations.md IAM section. |
| 4 | Derive mainnet Bitcoin address | **NOT STARTED** | Run `KmsSigningProvider.create()` → `bitcoin.payments.p2pkh()` with `bitcoin.networks.bitcoin`. Record the P2PKH treasury address. |
| 5 | Fund mainnet treasury | **NOT STARTED** | Send BTC to the derived mainnet address. Minimum: enough for ~1000 OP_RETURN transactions (~0.01 BTC at current fee rates). |
| 6 | Set production env vars | **NOT STARTED** | `BITCOIN_NETWORK=mainnet`, `KMS_KEY_ID=<key>`, `KMS_REGION=us-east-1`, `ENABLE_PROD_NETWORK_ANCHORING=true` |
| 7 | CloudTrail monitoring | **NOT STARTED** | Enable CloudWatch alarms for `kms:ScheduleKeyDeletion` and `kms:DisableKey` on the treasury key. See 14_kms_operations.md DR section. |
| 8 | Supabase production project | **NOT STARTED** | Provision production-tier Supabase project. Run all 49 migrations. |
| 9 | DNS + custom domain | **NOT STARTED** | `app.arkova.io` or equivalent. Configure Vercel custom domain. |
| 10 | Seed data strip | **NOT STARTED** | Remove demo users (admin_demo, user_demo, beta_admin) from production seed. |
| 11 | Entitlement plan change/downgrade | **NOT STARTED** | Handle subscription upgrades, downgrades, cancellations (CRIT-3 remaining work). |
| 12 | SOC 2 evidence collection | **NOT STARTED** | Begin at production launch. CI logs, RLS test results, audit events as evidence. |

**Remaining production blockers (3 code items + operational):**
1. **Signet E2E broadcast** — manual, requires WIF (Step 1 above)
2. **Plan change/downgrade flows** — CRIT-3 remaining code work
3. **AWS KMS + mainnet funding** — operational, follows 14_kms_operations.md
4. **Supabase production + DNS** — infrastructure provisioning

**Next session should:** Commit all pending changes (KMS tests, vitest threshold, 14_kms_operations.md, 00_index.md, signing-provider.ts v8 ignore). Push to PR #26. Merge if CI green. Then: Signet E2E broadcast (manual with WIF) or CRIT-3 plan change/downgrade flows.

**Completed sprints (archived):**
All sprint details moved to Claude project memory. Summary:
- CRIT Bug Fixes (2026-03-10): CRIT-1,4,5,6 all fixed
- Worker Hardening (2026-03-10): 6 sessions, 268 tests, 5 bugs fixed, all 80%+ thresholds pass
- E2E Testing (2026-03-10-11): 116 tests (86 E2E + 25 load + 5 perf)
- SonarQube Remediation (2026-03-11): ~100 issues, 24 hotspots resolved
- Story Docs (2026-03-10): 9 group files + index in `docs/stories/`
- P7-TS-02 Stripe (2026-03-11): 74 tests, pricing UI + useBilling + checkout pages
- P7-TS-09 Webhooks (2026-03-11): 34 tests, migration 0046, server-side secrets
- Bitcoin Signet (2026-03-11): SignetChainClient, factory updated, 268 worker tests
- Billing Endpoints (2026-03-11): Checkout + portal worker endpoints, IDOR fix
- Dependency Upgrade (2026-03-11): Vite 5→6, vitest 1→3, esbuild CVE fixed, 0 npm vulnerabilities
- P7-TS-11 Wallet Setup (2026-03-11): wallet.ts, CLI scripts, 13 tests
- P7-TS-12 UTXO Provider (2026-03-11): RpcUtxoProvider + MempoolUtxoProvider, factory, 35 tests
- Signet Test Fixes (2026-03-12): Fixed 6 failures, 101 chain tests, 363 worker total
- Broadcast Test Coverage (2026-03-12): PR #24, 6 new broadcast tests, anchoring worker docs
- CRIT-2 Code Complete (2026-03-12): All 8 steps done. BitcoinChainClient + provider abstractions + SupabaseChainIndexLookup + migration 0050. 408 worker tests.
- CRIT-3 Entitlement Enforcement (2026-03-12): migration 0049 (check_anchor_quota + bulk_create_anchors quota), useEntitlements hook, ConfirmAnchorModal quota gate, UpgradePrompt component
- PR #26 CodeRabbit Review (2026-03-12): 14 fixes committed (dd2c2f0), 12 deferred as DH-01 through DH-12 in docs/stories/10_deferred_hardening.md
- CRIT-2 Operational Readiness (2026-03-12): KMS signing 39 tests (98%+ coverage), vitest threshold, 14_kms_operations.md (DH-03 unblocked), 00_index.md updated (15 docs), signet integration tests (8), E2E silent skip fix. 455 worker tests across 19 files.

---

## Bug Tracker

> Non-blocking bugs and issues discovered during development. For production blockers, see CLAUDE.md Section 8 Critical Blockers.
> **Format required:** Every bug entry must include steps to reproduce, expected vs actual behavior, and resolution actions taken.

| ID | Date Found | Summary | Severity | Status | Detail |
|----|-----------|---------|----------|--------|--------|
| — | — | No bugs logged yet | — | — | — |

### Bug Entry Template

When logging a new bug, replace a row with this format:

```
| BUG-NNN | YYYY-MM-DD | Short summary | LOW/MEDIUM/HIGH | OPEN/IN PROGRESS/FIXED/WONT FIX | See below |
```

Then add a detail block below the table:

```markdown
#### BUG-NNN: [Short summary]
- **Found during:** [story ID or task]
- **Steps to reproduce:**
  1. [Step 1]
  2. [Step 2]
  3. [Step 3]
- **Expected behavior:** [What should happen]
- **Actual behavior:** [What actually happens]
- **Root cause:** [If known]
- **Actions taken:**
  - [Action 1 — date]
  - [Action 2 — date]
- **Resolution:** [Fix description, commit, or "OPEN"]
- **Regression test:** [Test file/name that prevents recurrence, or "None yet"]
```

---

## Things That Surprised Us (Institutional Knowledge)

- The backlog PDF audit notes go stale. CLAUDE.md Section 11 is updated more frequently and should be treated as source of truth for story completion status.
- ~~`SecureDocumentDialog` (individual path) used to fake inserts with setTimeout while `IssueCredentialForm` (org admin) worked correctly.~~ Both now use real Supabase inserts. Fixed 2026-03-10.
- ~~The Vercel deployment at `arkova-carson.vercel.app` shows "Ralph" in the browser tab.~~ Fixed 2026-03-10.
- ~~`package.json` name is still "ralph" — affects build artifacts and Vercel project name.~~ Fixed 2026-03-10.
- Google Drive search is unreliable with complex queries. Use `name contains 'X' or name contains 'Y'` chaining or `fullText contains` with folder parent IDs.
- The Gemini AI Integration Specification in Drive describes server-side document processing that violates the Constitution. Do not treat it as authoritative.
- CLAUDE.md project file in `/mnt/project/` requires a fresh session to pick up changes. If you update CLAUDE.md during a session, the changes won't be visible in the project file until next session.
