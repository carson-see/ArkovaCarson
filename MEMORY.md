# MEMORY.md — Arkova Living Project State

> **Last updated:** 2026-03-10
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
| CRIT-1 | `SecureDocumentDialog` uses `setTimeout` simulation — individual users cannot anchor documents. The org admin path (`IssueCredentialForm`) works correctly. Pattern to follow exists. | Prajal | **OPEN — Fix first** |
| CRIT-2 | No real Bitcoin chain client. `MockChainClient` is the only implementation. No `bitcoinjs-lib`, no OP_RETURN, no AWS KMS. | Specialist | **OPEN — Weeks 2-3** |
| CRIT-3 | No Stripe checkout flow. SDK initialized, webhook verification works, but no way to collect payment. | Carson/Prajal | **OPEN — Week 2** |
| CRIT-4 | Onboarding routes (`/onboarding/role`, `/onboarding/org`, `/review-pending`) render `DashboardPage` as placeholder. Components exist (`RoleSelector`, `OrgOnboardingForm`, `ManualReviewGate`). | Prajal | **OPEN — Quick fix** |
| CRIT-5 | Proof export is JSON-only. jsPDF is in deps. `generateAuditReport.ts` exists but JSON proof download handler is a no-op. | Prajal | **OPEN — Week 2** |
| CRIT-6 | `CSVUploadWizard` uses simulated processing. `useBulkAnchors` hook exists but wizard doesn't call it. | Prajal | **OPEN — Week 1** |
| CRIT-7 | Browser tab says "Ralph." `package.json` name and `index.html` title retain old codename. | Anyone | **OPEN — 15 min fix** |

### What's NOT Blocked

These areas are production-ready or very close:
- Database layer (45 migrations, RLS on all tables, audit trail immutable)
- Auth flow (Supabase auth, Google OAuth, AuthGuard + RouteGuard)
- Org admin credential issuance (`IssueCredentialForm` — real Supabase insert + Zod + audit log)
- Public verification portal (5-section display, `get_public_anchor` RPC, verification event logging)
- CI/CD (secret scanning, dep scanning, typecheck, lint, copy lint, tests)

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

---

## Repo Orientation

### Where Things Live
```
CLAUDE.md                          ← Rules, Constitution, story status (707 lines)
MEMORY.md                          ← This file. Living state, decisions, sprint context.
src/App.tsx                        ← React Router with AuthGuard + RouteGuard
src/components/anchor/             ← Document anchoring UI (SecureDocumentDialog is the broken one)
src/components/auth/               ← LoginForm, SignUpForm, AuthGuard, RouteGuard
src/components/organization/       ← IssueCredentialForm (working), MembersTable, RevokeDialog
src/components/public/             ← PublicVerifyPage (public verification portal)
src/components/verification/       ← PublicVerification (5-section result display)
src/hooks/                         ← All data hooks (useAnchors, useAuth, useProfile, etc.)
src/lib/copy.ts                    ← All UI strings (enforced by CI)
src/lib/validators.ts              ← Zod schemas for all writes
src/lib/fileHasher.ts              ← Client-side SHA-256 (Web Crypto API)
src/lib/routes.ts                  ← Named route constants
src/lib/switchboard.ts             ← Feature flags
services/worker/                   ← Express worker (anchoring jobs, Stripe webhooks)
services/worker/src/chain/         ← ChainClient interface + MockChainClient (real client TBD)
services/worker/src/stripe/        ← Stripe SDK + webhook verification
supabase/migrations/               ← 45 migrations (0001-0045, 0033 skipped)
supabase/seed.sql                  ← Demo data (admin_demo, user_demo, beta_admin)
docs/confluence/                   ← Architecture, data model, security, audit, retention docs
```

### Key Patterns to Follow
- **New hooks:** Follow `useAuth.ts` / `useAnchors.ts` pattern (Supabase query, loading/error state, refresh callback)
- **New components:** Go in `src/components/<domain>/` with barrel export in `index.ts`
- **New migrations:** Sequential numbering, include rollback comment, regenerate `database.types.ts`
- **Anchor creation (the right way):** See `IssueCredentialForm.tsx` — validateAnchorCreate() → supabase.insert → logAuditEvent. Do NOT follow `SecureDocumentDialog.tsx` (it's the broken one).

### Orphaned Code (built but not wired)
| File | What It Does | What's Missing |
|------|-------------|----------------|
| `src/components/embed/VerificationWidget.tsx` | Compact/full embeddable verification widget | Never imported. Needs route or standalone bundle. |
| `src/components/billing/BillingOverview.tsx` | Displays plan info, usage, payment method | Not wired to a route with real billing data. |
| `src/components/public/ProofDownload.tsx` | PDF/JSON download buttons | PDF works via generateAuditReport. JSON download still no-op. |

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

**Last session (2026-03-10):** Test coverage assessment revealed worker/chain critical path has 0% coverage. Decision made to do a ~1 week hardening sprint before starting Bitcoin chain integration (CRIT-2). CLAUDE.md Section 9 updated to add "Week 1: Worker Hardening" phase. Bitcoin Signet work shifted to Week 2-3.

**Worker hardening scope (6 tasks):**
1. Unit test `processAnchor()` — success, timeout, malformed receipt, duplicate
2. Test `processPendingAnchors()` job claim/completion flow
3. Test ChainClient interface contract (MockChainClient exercises real interface)
4. Wire webhook dispatch in `anchor.ts` (status → SECURED triggers delivery.ts)
5. Test webhook HMAC signing correctness
6. Anchor lifecycle integration test (PENDING → SECURED → webhook → public verify)

**Next session should:** Start hardening work — begin with task 1 (unit test processAnchor).

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
- `IssueCredentialForm` (org admin path) does real Supabase inserts correctly. `SecureDocumentDialog` (individual path) fakes it with setTimeout. They look like the same flow from the user's perspective but are completely different under the hood.
- The Vercel deployment at `arkova-carson.vercel.app` shows "Ralph" in the browser tab.
- `package.json` name is still "ralph" — affects build artifacts and Vercel project name.
- Google Drive search is unreliable with complex queries. Use `name contains 'X' or name contains 'Y'` chaining or `fullText contains` with folder parent IDs.
- The Gemini AI Integration Specification in Drive describes server-side document processing that violates the Constitution. Do not treat it as authoritative.
- CLAUDE.md project file in `/mnt/project/` requires a fresh session to pick up changes. If you update CLAUDE.md during a session, the changes won't be visible in the project file until next session.
