# Specialist Review Findings — Watch-Window Work Products (2026-07-20)

**Owner:** Release/Train lane (RTE). Five specialist reviewers (Architect, DBA, Bitcoin/chain, AI-eval, Performance) reviewed the window's work products read-only, window-safe (no prod writes, no soaking-branch/rig contact, no main push, no PR ready/merge; perf local/analytical only). This consolidates their verdicts and records the corrections folded back into the delivered artifacts.

## Verdicts at a glance

| Target | Reviewer | Verdict |
|---|---|---|
| PR #1601 anti-hollow-soak guards | Architect + Perf | **APPROVE-WITH-NITS**, 30/30 tests, O(n) sub-ms |
| 1552 waiver recommendation | Bitcoin/chain | **B1 REJECTED — premise empirically false; recommend B2 re-soak** |
| Migration 0358 apply-safety | DBA + Perf | **CONDITIONAL SIGN-OFF** — lock_timeout + drain-quiet apply |
| #1570 credit-deduction check plan | DBA | **SIGN-OFF w/ REQUIRED AMENDMENTS** — my rubric was wrong |
| 45-type corpus audit | AI-eval | **Core claim correct; one MAJOR correction (machinery on main)** |
| #1584 refresh-stats fix | DBA + Perf | **SIGN-OFF (T2 soak-gated)** — mechanism sound, serial optimal |

## The one that changed a decision — 1552 waiver (Bitcoin/chain, MAJOR)

My original memo recommended **B1** — a "docs-only `agents.md` union, runtime-diff-identical, no re-soak" waiver. The chain reviewer **ran the exact verification predicate** (`git diff fe17b370 <resolved> -- . ':(exclude)**/agents.md'`) via a local throwaway test-merge and found it **NOT empty: ~100 files / ~22,000 lines**. Clearing DIRTY pulls all of main's 80-commit post-soak tree onto the head — including 7 worker-runtime `.ts` files (notably `services/worker/src/utils/db.ts`, the transport rewrite under *every* journal RPC) and 3 `.yml`. The chain-durability logic itself is byte-identical to the soaked head AND TLA-verified (14 invariants, cert `proofPassed:true`), but the deployed combination `0358 + main's new db.ts/cron.ts` was **never co-soaked under the 3am drain**.
→ **1552 memo corrected:** B1 removed; **B2 (re-soak integrated head)** recommended, CTO may scope to an integration soak; **B3 honest residual-risk note** provided verbatim only if the calendar forces a waiver. Chain logic itself has **no blockers**.

## Corrections folded into delivered artifacts

1. **`1552-...waiver-memo`** — B1 rejected → B2/B3; added the DBA+Perf 0358 apply-safety guardrails (`lock_timeout='3s'`, pause anchor feeders, merge-time `0358` uniqueness recheck) and the Architect's evidence-block SHA re-stamp step for any soaking-branch head push.
2. **`rail-verification-log` (#1570 check)** — DBA correction: the `UNIQUE(org_id,reference_id,reason)` constraint makes "2 rows" physically impossible, so the old "FAIL=2 rows" rubric can never fire. Rewrote: assert `ENABLE_ORG_CREDIT_ENFORCEMENT` ON first (else vacuous/0 rows), **PASS = exactly 1 row AND reference_id==anchor.id**, RED = 0 rows or idempotency conflict, filter `reason='anchor.create'`; removed the `GROUP BY … HAVING count>1` sweep (constraint-blind + false-positives on refunds).
3. **`w2w3-closure-artifacts` (corpus audit)** — AI correction: the acceptance machinery (registry/envelope/batch-acceptance/coverage-audit/leakage scanner) is **already on main** (SCRUM-2777, 07-15); #1557 is a self-exclusion prerequisite, not the missing evaluator. Added EDUCATION latent-coverage note; added mandatory re-acceptance controls to the SCRUM-2997 seed (rebuild digest chain from main base, re-run leakage+embedding vs current main, re-verify authored provenance).
4. **`fired-team-...salvage`** — AI: pinned head SHAs (#1556 `0a3caf09`, #1563 `b8ff95be`, #1566 `5ffd68e8`, #1557 `4134d41c`) + the durable `refs/pull/<N>/head` recovery fallback.
5. **`rig-reservation-...registry`** — Architect MAJOR: added the canonical-reservation-gap warning — `0359+` is only reserved in this memo, not in the (W3-frozen) `supabase/migrations/agents.md`, so a parallel session would legitimately compute `0359` and never see it. Flagged as a live collision risk; landing the numbered row is owed post-window.

## Open items for the reviewers' deferred (credentialed) checks
Both DBA and chain flagged prod-credentialed checks the release-ops/apply session must run: 0358's `anchors` trigger-lock window + open-PR `0358` recheck; #1570's `ENABLE_ORG_CREDIT_ENFORCEMENT` prod flag state; #1584's six `refresh_cache_*` EXECUTE grants for the worker role + the future matview-drop `pg_depend` confirmation; #1552's `ENABLE_BATCH_ANCHORING` ON before ship.

## #1601 nits for post-train ci.yml wiring (Architect + Perf)
Add a Zod schema on the parsed CLI input; `DeployLogRow.at` is currently unused (it's the hook for a missing **clock-started-before-deploy** guard); consider matching the `::error::`-only log style. **Four missing hollow-soak signatures the guard set should gain before wiring:** (a) **clean-mirror preflight** (consume `staging-honesty-preflight.ts` `environment_type=clean_mirror` — highest value), (b) **cross-project evidence copy** (add `supabaseRef` to the deploy-provenance tuple), (c) **clock-started-before-deploy** (`soak_start >= deploy_log.at`), (d) **build-at-head image-digest ↔ head-SHA** binding. Also reconcile against the held #1565 `s33-drain-invariant.ts` before wiring (dead-code/overlap). Perf: sub-ms at realistic n; only nit is failure-branch diagnostics build full enumeration strings (cap someday). All non-blocking for a Draft PR.
