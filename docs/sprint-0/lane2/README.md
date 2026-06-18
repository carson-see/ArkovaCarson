# Lane 2 (Product & Growth) — PI-1 Sprint 0 deliverables

> **Lane:** L2 — Product & Growth. **Sprint:** PI-1 Sprint 0 (Foundation & Hardening). **Date:** 2026-06-18.
> **Tier:** T0 (read-only specs/designs; no running-surface change). **Branch:** `lane2/s0-visibility-predesign`. **Milestone:** Sprint 0 — Foundation & Hardening (GitHub #24).
> **Operated by:** Claude under Carson's (CPO) oversight + sole T2/T3 merge gate.
> **Guardrails honored:** no merge to main; no prod/staging/Supabase/soak mutation; **Train C #1154 + Train D rigs untouched**; no edits to existing PRs (#1208–#1211); no Drive/Confluence destruction. All external/irreversible/cross-lane actions flagged for Carson.

This PR is the Lane-2 slice of Sprint 0 — **specs + designs only**, no code. It closes the open Lane-2 gap left by the prior train/Lane-1/S0-E4 sessions (PRs #1208–#1211): the **S0-5.1 internal-visibility dashboard spec** plus the Lane-2 Sprint-1 pre-designs.

## Contents

| File | What | Feeds |
|---|---|---|
| [`00-ceremonies.md`](./00-ceremonies.md) | Lane-2 sprint refinement + planning + pre-mortem + retro | this sprint |
| [`S0-5.1-internal-visibility-dashboard-spec.md`](./S0-5.1-internal-visibility-dashboard-spec.md) | **OWNED.** Internal-visibility dashboard spec — DOUBLE_BILLING_RISK / fail-open flags / key-secret expiry; data sources, metrics, shared thresholds, admin-only surfacing | Sprint-1 **VIS-01** (SCRUM-2510) + shared thresholds → Lane-1 **S0-5.2** drift gate |
| [`api-key-expiry-dashboard-design.md`](./api-key-expiry-dashboard-design.md) | API-key / secret expiry dashboard + T-30 alarm design (deep mechanism for Signal 3) | Sprint-1 **KEY-EXPIRY** (SCRUM-2507) |
| [`revenue-funnel-predesign.md`](./revenue-funnel-predesign.md) | verified_individual pricing/sell, credit-pack purchase + ledger UI, self-serve org signup + domain verification | Sprint-3 monetization (objective O2) |
| [`instant-secure-predesign.md`](./instant-secure-predesign.md) | Instant-Secure product/UX + flag-flip (money path fail-CLOSED; gated by DOUBLE_BILLING_RISK alarm) | S4→S7 Instant Secure (objective O3) |
| [`verification-findings.md`](./verification-findings.md) | Code-review + debug pass verifying F1–F7 against real code (verdicts + `file:line` evidence) | this sprint |
| [`spec-citation-audit.md`](./spec-citation-audit.md) | Independent audit of ~150 spec citations ("technically sound: YES"; 5 minor fixes applied) | this sprint |

## Sprint-0 Lane-2 Definition-of-Done scorecard

| DoD item (Sprint 0 plan, Lane 2 block) | Status |
|---|---|
| Internal-visibility spec **approved with named owner** (3 signals; data sources/metrics/admin-only; read-only; impl deferred Sprint 1+) | **DONE (draft, for review)** — owner = L2 Architect lead; DBA review in-lane (checklist, satisfiable at T0); Bitcoin-Dev (Lane-1) formal review **pending #1208 publication** (inventory already folded in) |
| Revenue funnel **pre-designed so Sprint 1 codes not scopes** | **DONE** — `revenue-funnel-predesign.md` (10 Sprint-1 stories w/ rough AC) |
| Instant Secure **pre-designed** | **DONE** — `instant-secure-predesign.md` (UX + flag + fail-closed + S4→S7 dependency map) |
| API-key-expiry dashboard **design** | **DONE** — `api-key-expiry-dashboard-design.md` (feeds SCRUM-2507) |
| Onboarding (read list, bootstrap-ack, first low-risk T0/T1 PR) | **DONE** — read list covered; `ack-claude-bootstrap.sh` passed; this docs PR is the first T0 |
| Tests written-first + green **where code is involved** | **N/A** — specs only this sprint (no production code; the plan scopes Lane-2 Sprint-0 as T0 read-only) |
| Confluence current | **DONE** — S0-5.1 spec page filed under Sprint-0 AUDIT (83689473) |
| Jira transitioned with subtasks closed | **DONE** — SCRUM-2530 + subtasks 2531–2534 transitioned to Done (2026-06-18). Spec stories carry no code-on-main/prod-green gate, so "Needs Human" was wrong — corrected per Carson |
| agents.md / HANDOFF updated | agents.md **DONE** (this folder); **HANDOFF entry deferred** to avoid a merge collision with #1208 (both append to "Now") — ready-to-paste text below (CLAUDE.md §6) |
| Reviewed + merged per tiered-merge | **Carson merges** (this PR is T0/docs but references the #1208 manifest → merge after #1208) |

## Findings surfaced during pre-design (NOT fixed — Lane-2 is specs-only this sprint)

The grounded code reading turned up several issues. A **code-review + debug pass verified each against the actual code** (see [`verification-findings.md`](./verification-findings.md)): **F2–F7 CONFIRMED**, **F1 PARTIAL** (narrower than first flagged). They are documented here and flagged for Carson. **None were fixed** (out of T0 spec scope; F3/F4/F5 are billing/credits = T2 → your merge + staging soak), **none auto-filed to the bug tracker** (the auth one needs your severity/disclosure call). Recommend bug-tracker entries — I can file F1–F7 on your go.

| # | Finding | Severity (candidate) | Source cited | Where captured |
|---|---|---|---|---|
| **F1** | `validate_api_key` ignores `api_keys.expires_at` → expired key still authenticates. **VERIFIED PARTIAL** — the hole is on the **edge MCP path only** (`mcp-server.ts:781-808`); worker `/api/v1`+`/api/v2` *do* reject expired keys (`apiKeyAuth.ts:189`, `v2/auth.ts:59`) | **High (edge-scoped)** | `0299_validate_api_key_rpc.sql:82` (+0302/0303); edge `mcp-server.ts:781` | verification-findings.md |
| **F2** | `services/worker/src/jobs/secret-rotation-reminder.ts` is effectively **dead** — `getSecretInventory()` hardcodes `lastRotatedAt: new Date()` and `runSecretRotationCheck()` is wired to no cron, so it never fires | **Med** | `secret-rotation-reminder.ts:20-38` | key-expiry design §flags |
| **F3** | **No webhook branch grants credits** for a paid `mode:'payment'` credit-pack checkout (`handleCheckoutComplete` handles subscriptions only; dev-mode grants directly, "never in production") | **High (revenue)** | `stripe/handlers.ts` `handleCheckoutComplete` | revenue-funnel §6 (story S3-CREDIT-GRANT) |
| **F4** | `check_unified_credits` returns `(50,0,50,true)` (fail-**OPEN**) for a missing balance row | **High (money-safety)** | worker `check_unified_credits` | revenue-funnel §8 |
| **F5** | Credit ledger **diverges across 3 tables** — `credits` (frontend `get_user_credits`), `unified_credits` (worker `check_unified_credits`), `org_credits` (worker `deduct_org_credit`) | **High (launch-critical)** | three RPCs | revenue-funnel §8 |
| **F6** | **Credit-pricing concept collision** — policy "$1.25/credit (instant anchoring)" vs live `CREDIT_PACKS` ~$0.003–0.01/credit (API/verification credits, PAY-01); one word, two products | **Med** | `services/worker/src/api/v1/credits.ts` | revenue-funnel §8 |
| **F7** | Platform-admin RBAC drift — frontend `src/lib/platform.ts isPlatformAdmin()` = hardcoded `PLATFORM_ADMIN_EMAILS`; worker = `profiles.is_platform_admin` DB flag | **Med** | `platform.ts` vs `platformAdmin.ts` | key-expiry §flags; visibility §3.3 (treats worker flag as authoritative) |
| **F8** | `org_credit_deductions.reference_id` is **not** a FK to `anchors.id` (FAST_TRACK uses `organization_rule_executions.id`) → DOUBLE_BILLING_RISK metric needs reference-chain resolution, not a naive join | Design detail (informs VIS-01) | migration `0326` | visibility §2.1 |
| **F9** | `flagRegistry.ts` still **env-falls-back on a DB blip** for kill-switches (fail-open) — the documented 2026-05-30 finding / SCRUM-2247 out-of-scope follow-up | **Med (known)** | `flagRegistry.ts:114-117`; `middleware/agents.md:30-43` | visibility §2.2 (the signal this dashboard makes visible) |
| **F10** | `ENABLE_ORG_CREDIT_ENFORCEMENT` defaults **OFF** → instant anchoring would be free without it (GA gating consideration) | Med (design) | flag default | instant-secure §8 (Q1) |
| **F11** | `FAST_TRACK_ANCHOR` (`rule-action-dispatcher.ts`) is the **existing machine-initiated instant-secure** — L2-D is its user-initiated sibling reusing the same primitives | Design insight | `rule-action-dispatcher.ts` | instant-secure §intro |

## Decisions for Carson

**Visibility (S0-5.1):** page placement (dedicated `/admin/visibility` vs SystemHealth section — rec dedicated); `anchor_without_charge` page threshold N; shared-threshold module home (so VIS-01 + S0-5.2 import one definition); full kill-switch set vs the named three; OK to ship the 2 Lane-1-pending metrics (M1c duplicate-broadcast source, M2b fallback denominator) as "source pending Lane-1"?
**Key-expiry:** enforce `expires_at` in the auth RPC (F1)? exact CE expiry date + custody timing; L1 rotation thresholds; align frontend RBAC to the DB flag (F7); standardize alerting on Sentry→alert-rules.
**Revenue funnel:** resolve the credit-pricing collision (F6); `verified_individual` price + included anchors; pick the canonical credit ledger (F5); flip the fail-open balance default (F4); name the org-creation write path.
**Instant Secure:** require `ENABLE_ORG_CREDIT_ENFORCEMENT` ON at the S6 flag flip (F10)? reference_id minting (client vs server); reorg→refund UX; bulk Instant Secure (S7 or out of PI-1); confirm 1 credit/doc; DB-backed switchboard flag.
**Cross-lane / process:** Bitcoin-Dev (Lane-1) formal review of S0-5.1 is pending #1208 publication; CE custody clock is Lane-3 (S0-7.2); proof/WIF clocks are Lane-1. Recommend bug-tracker entries for F1–F7 after triage (not auto-filed).

## HANDOFF.md entry — ready to paste (kept OUT of this PR to avoid a merge collision with #1208)

```markdown
### 2026-06-18 — Lane 2 (Product & Growth) Sprint-0 slice: visibility spec + Sprint-1 pre-designs (draft PR, nothing merged)

Lane-2 Sprint-0 delivered as **draft PR #NNNN** (`lane2/s0-visibility-predesign`, milestone #24): the OWNED **S0-5.1 internal-visibility dashboard spec** (DOUBLE_BILLING_RISK / fail-open flags / key-secret expiry — built entirely on existing collection; shared thresholds with Lane-1's S0-5.2 gate) + Lane-2 pre-designs for KEY-EXPIRY (SCRUM-2507), the revenue funnel (O2), and Instant Secure (O3). **T0 specs only — no code/migration/prod/staging/soak change; Train C #1154 + Train D rigs untouched; no existing PR touched.** Jira: S0-5.1 filed under SCRUM-2513 → Needs Human (no Done). Confluence: S0-5.1 spec page under 83689473. Pre-design reading surfaced candidate issues F1–F7 (auth: expired API keys still validate; revenue: credit-pack webhook grant gap; money-safety: fail-open balance default + 3-table credit-ledger divergence) — documented in docs/sprint-0/lane2/README.md, flagged for Carson, not fixed, not auto-filed.

_Last refreshed: 2026-06-18 by Claude (carson@arkova.io) — Lane-2 draft PR #NNNN verified via gh; no prod state asserted; all reads read-only._
```
