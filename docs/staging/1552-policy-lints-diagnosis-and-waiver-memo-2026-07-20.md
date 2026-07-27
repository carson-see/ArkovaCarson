# PR #1552 — Policy-Lints Red: Diagnosis + CTO Waiver / Re-Soak Memo

**Author:** Release/Train lane (RTE), 2026-07-20T18:50Z — read-only diagnosis per Safe-Work-Order W5.
**Subject:** [SCRUM-2692] durable pre-broadcast txid recovery journal (migration `0358_scrum2692_anchor_txid_journal.sql`).
**Rail:** railb220260719, matures **2026-07-21T17:13Z**. Head `fe17b370`, branch `agent/s33-w2-l1-t0-gate-audit`, base `main`.

## Verdict (one line)

The Policy-Lints red is **NOT** a stale-evaluation-context failure — so the sanctioned fresh-event body-edit mint **does not apply and must not be used to mask it**. It is a single, intentional, expected-red rule (`feedback_local_matches_prod`) that clears only when release-ops applies `0358` to prod pre-merge. Separately, the PR is now **DIRTY/CONFLICTING** against main — that is the real merge blocker for 17:13Z, and resolving it needs a head push to the soaking branch = **CTO escalation (W5)**.

## Read-only evidence

**Check state at head `fe17b370` (via `gh pr checks 1552`):**

| Check | Result | Root cause |
|---|---|---|
| Policy Lints | **fail** | `feedback_local_matches_prod` — the one failing rule of 7 ("Summary: 6/7 rules passed"). Log line: `feedback_local_matches_prod remains intentionally red until migration 0358 is released; this lane did not apply it to production.` |
| Check `supabase/migrations` vs prod | **fail** | Same root cause — `0358` present in the PR tree, absent from prod. |
| Staging Soak Evidence Gate | **fail** | railb2 soak still maturing (17:13Z Jul 21). Expected; frozen evidence. |
| TypeCheck & Lint | **pass** | — |

**Mergeability (via `gh pr view`):** `mergeable: CONFLICTING`, `mergeStateStatus: DIRTY`. Compare `fe17b370...main` = diverged, **80 ahead / 4 behind**.

**Conflict surface:** 1552 edits these `agents.md` files that main *also* advanced during the soak → GitHub does not honor `merge=union`, so they collide:
- `services/worker/src/jobs/agents.md` (touched by both 1552 and post-soak main)
- `supabase/migrations/agents.md` ("Recent migrations" EOF block — the exact class of collision called out in CLAUDE.md §6 and the 2026-07-20 RM learnings)
- plus 1552's other `agents.md` edits (`machines/`, `services/worker/`, `services/worker/src/chain/`, `services/worker/src/types/`, `src/types/`) against main's broad `agents.md` sweep.

1552 also edits `.github/workflows/ci.yml` — a **W3-frozen file**. That is the PR's own committed content (not something this lane touches); noted so the reviewer is aware it rides in the rail.

## Why the fresh-event mint is wrong here

The body-edit fresh-event mint re-stamps the Staging-Soak-Evidence-Gate evaluation context. It does nothing for:
1. `feedback_local_matches_prod` — clears **only** when `0358` is physically applied to prod. That is the release-ops-owned "0358 prod-apply BEFORE merge" step (runbook: automation armed 13:18 ET Jul 21). A body edit cannot apply a migration.
2. The DIRTY conflict — clears **only** by resolving the `agents.md` unions on the head branch and pushing. A body edit cannot change the tree.

Masking either with a body edit would be a §1.5 honesty violation (asserting green that isn't earned). **Recommendation: do not body-edit 1552.**

## The real decision for CTO (both need a ruling before 17:13Z)

### Decision A — prod-apply of `0358` (clears Policy-Lints + migrations-vs-prod)
This is already in the parallel release-ops runbook ("0358 prod-apply precedes its merge", automation armed 13:18 ET Jul 21). No new decision needed unless the DIRTY state below changes the merge plan. Once applied + §0-rule-10 ledger reconcile (numeric `0358` present in prod ledger), both reds go green on the next check run.

### Decision B — the DIRTY conflict resolution (the actual blocker) — **needs CTO sign-off**
The head branch is a **soaking rail branch**. Resolving the `agents.md` unions requires a local union merge + **push to `agent/s33-w2-l1-t0-gate-audit`**. Per W5 and `feedback_dont_touch_soaking_prs`, any head push to a soaking branch is frozen-evidence disruption and requires CTO escalation. Two options:

- **B1 — "docs-only union, no re-soak": REJECTED — premise empirically FALSE (Bitcoin-engineer review, 2026-07-20).** The chain-review did the local test-merge this memo originally proposed and ran the exact predicate `git diff fe17b370 <resolved> -- . ':(exclude)**/agents.md'` → **NOT empty: ~100 files / ~22,000 lines, exit 1.** Clearing DIRTY necessarily brings all of main's 80-commit post-soak tree onto the head, including **7 worker-runtime `.ts` files** — notably `services/worker/src/utils/db.ts` (the Supabase transport rewrite under EVERY journal RPC/UPDATE, SCRUM-2899) plus `routes/cron.ts`, `webhooks/delivery.ts`, `ai/gemini.ts`, `ai/fallback-chain.ts`, `jobs/pipelineThroughputMonitor.ts`, `utils/sentry.ts` — and 3 `.yml` (`deploy-worker.yml`, `.mergify.yml`, `s33-wave2-batch-acceptance.yml`). So the merged/deployed artifact is **not** runtime-identical to what railb2 soaked. The RC-manifest precedent does NOT transfer (those deltas were docs/manifest only). **Do not approve a waiver that claims "docs-only / runtime-diff-identical" — that assertion is false and would be a §1.5 violation.**
- **B2 — re-soak the integrated head (RECOMMENDED):** per §1.11A ("any runtime commit after a soak invalidates exact-head evidence"), the deployed combination `0358 + main's new db.ts/cron.ts` was **never co-soaked under the 3am drain**. Re-soak the *merged* head. The chain-durability logic itself is byte-identical to `fe17b370` AND independently TLA-verified (14 invariants, cert `proofPassed: true`), so the CTO MAY scope this to a shorter **integration soak** exercising the journal/batch-drain path on the merged tree rather than a full cold 48h T3 — CTO's call. Cost: misses 17:13Z maturity; flag calendar impact to founder.
- **B3 — honest residual-risk note (only if schedule forces a waiver):** permissible ONLY with the accurate, weaker claim — *"chain-durability surface byte-identical to fe17b370 and TLA-verified; merged artifact additionally carries 7 shared worker-runtime `.ts` files (notably `utils/db.ts` transport under every journal RPC + `routes/cron.ts`) and 3 `.yml` from independently-soaked main PRs; residual risk = not co-soaked with 0358 under the 3am flush."* This is a different, weaker claim than B1 and must be labeled as such.

**RTE recommendation (corrected post-review): B2** (re-soak the integrated head, CTO may scope to an integration soak). B3 only if the calendar hard-blocks. **B1 is off the table — its factual predicate was disproven.** Decision A (0358 prod-apply) proceeds on schedule but see the added apply-safety guardrails below.

## 0358 prod-apply safety guardrails (DBA + Perf review — required for Decision A)

Both the DBA and Performance reviews independently flagged the **same apply-time risk**: `CREATE TRIGGER guard_anchor_txid_journal_lifecycle BEFORE UPDATE OF status ON public.anchors` takes a **SHARE ROW EXCLUSIVE** lock on the ~2.97M-row `anchors` table. It's metadata-only (no rewrite/scan, instant once acquired), but it conflicts with all row writes — applied during the live 255k drain / 3am flush it will **queue behind in-flight write txns and stall new anchor writes** until it acquires the catalog lock (a 10k-row flush txn ahead of it = a multi-second write stall). Release-ops MUST, when applying 0358:
1. **`SET lock_timeout = '3s';`** at the top of the apply so the trigger creation fails fast + retries rather than head-of-line-blocking the drain.
2. **Pause the anchor feeders** (`process-anchors`, `anchor-public-records`) for the apply, or pick a genuinely drain-quiet window.
3. **Re-run the open-PR `0358` uniqueness check at merge time** (`gh pr list … | grep 0358`) — one session's scan 502'd; confirm no sibling PR grabbed the prefix.
4. Then the §0-rule-10 numeric-ledger reconcile + `list_migrations` numeric-head confirm.
Steady-state cost is negligible (the trigger short-circuits on `status IN ('REVOKED','SUPERSEDED')` before touching the journal; the drain's PENDING→…→SECURED path pays ~two scalar comparisons/row). The only real risk is the apply moment.

## Evidence-block SHA re-stamp (Architect review — required for B2/B3)

Any resolution that pushes a new head to the soaking branch **bumps the head SHA and invalidates the exact-head evidence block** (`feedback_pr_head_sha_in_evidence_block`) and re-triggers the staging gate against the new head. So the B2/B3 runbook MUST include: re-stamp the PR body's `PR head SHA` to the resolved head (`gh pr edit`) or the gate evaluates a stale head. (Head push to the soaking branch is itself CTO-gated per W5 — not self-authorized.)

## Pre-drafted artifacts (ready to attach to the ruling)

1. **B2 integration-soak trigger:** stand up a fresh isolated chain rig per `docs/reference/STAGING_RIG.md` + isolated-soak procedure, build-at-*merged*-head, exercise the journal/batch-drain path (Trigger-A/B + daily-flush + per-org isolation); chain logic is byte-identical + TLA-verified so CTO may scope shorter than a cold 48h T3. Misses 17:13Z — flag calendar impact to founder.
2. **B3 honest residual-risk note (verbatim, only if schedule forces it):** *"Chain-durability surface byte-identical to soaked head fe17b370 and TLA-verified (14 invariants, cert proofPassed:true). Merged artifact additionally includes 7 shared worker-runtime `.ts` files — notably `services/worker/src/utils/db.ts` (transport under every journal RPC) and `routes/cron.ts` — plus 3 `.yml`, all from independently-soaked main PRs. Residual risk = these were not co-soaked with 0358 under the 3am flush. Approver: CTO."* — Verification command result to attach: the `git diff … ':(exclude)**/agents.md'` output showing the chain files unchanged and enumerating the non-chain runtime deltas.

## What this lane does NOT do (boundary)

Per the ownership boundary, this lane does **not** drive 1552's requeue, the `0358` prod-apply, or any head push. This memo is the read-only diagnosis + pre-drafted waiver options for the CTO ruling. The parallel release-ops session executes whichever option CTO approves.
