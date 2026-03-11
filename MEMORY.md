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
| CRIT-2 | Bitcoin chain client — partial | Specialist | **PARTIAL.** SignetChainClient implemented (`bitcoinjs-lib`, OP_RETURN `ARKV` prefix). Factory updated. Wallet utilities (P7-TS-11): `wallet.ts`, CLI scripts, 13 tests. UTXO provider (P7-TS-12): `RpcUtxoProvider` + `MempoolUtxoProvider`, factory, 35 tests. 147 chain tests total (6 files). **Remaining:** AWS KMS signing (mainnet), Signet node connectivity test, mainnet treasury funding. |
| CRIT-3 | Stripe checkout — partial | Carson/Prajal | **PARTIAL.** Pricing UI + useBilling hook + checkout/portal worker endpoints wired (b1f798a). 74 tests. **Remaining:** entitlement enforcement, plan change/downgrade. |
| ~~CRIT-4~~ | ~~Onboarding routes are placeholders~~ | ~~Prajal~~ | ~~**RESOLVED 2026-03-10.** Wired RoleSelector, OrgOnboardingForm, ManualReviewGate. Commit a38b485.~~ |
| ~~CRIT-5~~ | ~~Proof export JSON download is no-op~~ | ~~Prajal~~ | ~~**RESOLVED 2026-03-10.** Wired onDownloadProofJson. Commit a38b485.~~ |
| ~~CRIT-6~~ | ~~CSVUploadWizard uses simulated processing~~ | ~~Prajal~~ | ~~**RESOLVED 2026-03-10.** Connected to csvParser + useBulkAnchors. Commit a38b485.~~ |
| ~~CRIT-7~~ | ~~Browser tab says "Ralph."~~ | ~~Anyone~~ | ~~**RESOLVED 2026-03-10.** `package.json` name → `arkova`, `index.html` title → `Arkova`.~~ |

### What's NOT Blocked

These areas are production-ready or very close:
- Database layer (48 migrations, RLS on all tables, audit trail immutable)
- Auth flow (Supabase auth, Google OAuth, AuthGuard + RouteGuard)
- Org admin credential issuance (`IssueCredentialForm` — real Supabase insert + Zod + audit log)
- Individual anchor creation (`SecureDocumentDialog` — fixed, real Supabase insert)
- Public verification portal (5-section display, `get_public_anchor` RPC, verification event logging)
- CI/CD (secret scanning, dep scanning, typecheck, lint, copy lint, tests)
- Worker test coverage (363 tests, 80%+ on all critical paths)
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
supabase/migrations/               ← 48 migrations (0001-0048, 0033 skipped)
supabase/seed.sql                  ← Demo data (admin_demo, user_demo, beta_admin)
docs/confluence/                   ← 14 docs (00-13): architecture, data model, security, etc.
docs/stories/                      ← Story docs (9 group files + index)
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

**Last session (2026-03-12 ~1:00 AM EST):** Documentation audit across all project files. Updated CLAUDE.md, MEMORY.md, bug_log.md, story docs. PR #24 created for broadcast test coverage + anchoring worker docs.

**Current state:**
- 682 total tests (363 worker + 319 frontend) + 116 E2E/load tests
- All worker critical paths at 80%+ coverage (17 test files, 363 tests)
- 147 chain-specific tests across 6 files (signet 30, utxo-provider 31, wallet 13, client 9, mock 18, anchor 46)
- Worker hardening sprint COMPLETE (6/6 tasks, 5 bugs found/fixed)
- Vite 6.4.1 + vitest 3 + esbuild 0.25.12 (CVE patched, 0 npm vulnerabilities)
- SignetChainClient + UTXO providers + wallet utilities all implemented
- Stripe checkout/portal endpoints wired with JWT auth
- Webhook delivery engine complete with HMAC signing + exponential backoff

**Remaining production blockers (5 items):**
1. AWS KMS signing for mainnet Bitcoin
2. Signet node connectivity test (fund treasury via faucet, run live broadcast)
3. Mainnet treasury funding
4. Entitlement enforcement (restrict features by billing plan)
5. Plan change/downgrade flows

**Next session should:** Pick up one of the remaining blockers above, or address any remaining GitHub PRs.

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
